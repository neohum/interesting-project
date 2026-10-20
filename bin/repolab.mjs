#!/usr/bin/env node
// repolab — 트렌딩 레포 목록 검색 · 클론 · 실행 도우미 (의존성 없음, Node 18+)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { platform } from 'node:os';
import { dirname, join, resolve, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = platform() === 'win32';
const { meta, repos } = JSON.parse(readFileSync(join(ROOT, 'data/repos.json'), 'utf8'));
const { picks, mentions } = JSON.parse(readFileSync(join(ROOT, 'data/picks.json'), 'utf8'));
const pickById = new Map(picks.map((p) => [p.id, p]));

// ── 출력 ────────────────────────────────────────────────────────────
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), cyan: paint(36), magenta: paint(35) };
const LEVEL_COLOR = { ready: c.green, heavy: c.yellow, gpu: c.red, apple: c.magenta, key: c.blue, skill: c.cyan, unknown: c.dim };
const LEVEL_LABEL = { ready: '로컬OK', heavy: '무거움', gpu: 'GPU', apple: 'Apple', key: 'API키', skill: '스킬', unknown: '확인필요' };

// 한글·CJK는 터미널에서 두 칸을 차지한다
const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
const width = (s) => [...String(s).replace(/\x1b\[\d+m/g, '')].reduce((w, ch) => w + (wide(ch.codePointAt(0)) ? 2 : 1), 0);
function fit(s, w) {
  s = String(s);
  if (width(s) <= w) return s + ' '.repeat(w - width(s));
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > w - 1) break;
    out += ch;
  }
  return out + '…' + ' '.repeat(Math.max(0, w - width(out) - 1));
}
const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const die = (msg, code = 1) => { console.error(c.red('✗ ') + msg); process.exit(code); };

// ── 인자 ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && VALUE_FLAGS.has(k)) opt[k] = argv[++i];
      else opt[k] = true;
    } else if (a === '-y') opt.yes = true;
    else if (a === '-h') opt.help = true;
    else pos.push(a);
  }
  return { pos, opt };
}
const VALUE_FLAGS = new Set(['cat', 'local', 'lang', 'sort', 'limit', 'dir', 'port', 'out', 'jobs']);

// ── 레포 찾기 ───────────────────────────────────────────────────────
function findRepo(q) {
  if (!q) die('레포 이름을 주세요. 예: repolab show excalidraw');
  const lq = q.toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const exact = repos.find((r) => r.id.toLowerCase() === lq);
  if (exact) return exact;
  const byName = repos.filter((r) => r.id.split('/')[1].toLowerCase() === lq);
  if (byName.length === 1) return byName[0];
  const partial = repos.filter((r) => r.id.toLowerCase().includes(lq));
  if (partial.length === 1) return partial[0];
  const cands = byName.length ? byName : partial;
  if (cands.length) die(`"${q}"에 해당하는 레포가 여러 개입니다:\n  ${cands.map((r) => r.id).join('\n  ')}`);
  die(`"${q}"를 목록에서 찾지 못했습니다. repolab search ${q} 로 검색해 보세요.`);
}

function searchScore(r, terms) {
  const p = pickById.get(r.id);
  const fields = [[r.id, 5], [r.ko, 3], [r.desc, 2], [r.cat, 2], [r.lang, 2], [p ? `${p.tagline} ${p.why} ${p.outputs.join(' ')} ${p.minis.map((m) => m.name + m.desc).join(' ')}` : '', 1]];
  let total = 0;
  for (const t of terms) {
    const s = fields.reduce((acc, [f, w]) => acc + (String(f || '').toLowerCase().includes(t) ? w : 0), 0);
    if (!s) return 0;
    total += s;
  }
  return total;
}

function filterRepos(list, opt) {
  let out = list;
  if (opt.cat) out = out.filter((r) => r.cat.includes(opt.cat));
  if (opt.local) {
    const want = String(opt.local).split(',');
    out = out.filter((r) => want.includes(r.local));
  }
  if (opt.lang) out = out.filter((r) => r.lang.toLowerCase() === String(opt.lang).toLowerCase());
  if (opt.picks) out = out.filter((r) => pickById.has(r.id));
  const sort = opt.sort || 'stars';
  const key = { stars: (r) => -r.stars, forks: (r) => -r.forks, name: (r) => r.id.toLowerCase() }[sort];
  if (!key) die(`--sort 값은 stars | forks | name 중 하나입니다.`);
  out = [...out].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (opt.limit) out = out.slice(0, Number(opt.limit));
  return out;
}

function printTable(list) {
  if (!list.length) return console.log(c.dim('  (결과 없음)'));
  const cols = Math.max(80, process.stdout.columns || 100);
  const descW = Math.max(20, cols - 2 - 38 - 2 - 10 - 2 - 6 - 2 - 8 - 2);
  console.log(c.dim(`  ${fit('레포', 38)}  ${fit('언어', 10)}  ${fit('★', 6)}  ${fit('로컬', 8)}  설명`));
  for (const r of list) {
    const star = pickById.has(r.id) ? c.yellow('◆') : ' ';
    const lv = LEVEL_COLOR[r.local](fit(LEVEL_LABEL[r.local], 8));
    console.log(`${star} ${c.bold(fit(r.id, 38))}  ${fit(r.lang || '-', 10)}  ${fit(fmtNum(r.stars), 6)}  ${lv}  ${fit(r.ko, descW)}`);
  }
  console.log(c.dim(`\n  ${list.length}개 · ${c.yellow('◆')} = 추천 프로젝트 · 자세히: repolab show <이름>`));
}

// ── 명령: list / search / show / picks / cats ───────────────────────
function cmdList(pos, opt) {
  const list = filterRepos(repos, opt);
  if (opt.json) return console.log(JSON.stringify(list, null, 2));
  printTable(list);
}

function cmdSearch(pos, opt) {
  const terms = pos.map((t) => t.toLowerCase()).filter(Boolean);
  if (!terms.length) die('검색어를 주세요. 예: repolab search hwp');
  const hits = filterRepos(repos, { ...opt, sort: opt.sort || 'stars', limit: undefined })
    .map((r) => [r, searchScore(r, terms)])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || b[0].stars - a[0].stars)
    .map(([r]) => r);
  const list = opt.limit ? hits.slice(0, Number(opt.limit)) : hits;
  if (opt.json) return console.log(JSON.stringify(list, null, 2));
  printTable(list);
}

function cmdShow(pos, opt) {
  const r = findRepo(pos[0]);
  const p = pickById.get(r.id);
  if (opt.json) return console.log(JSON.stringify({ ...r, pick: p || null }, null, 2));
  console.log(`\n${c.bold(r.id)}  ${LEVEL_COLOR[r.local](`[${LEVEL_LABEL[r.local]}]`)}  ${c.dim(r.cat)}`);
  console.log(`  https://github.com/${r.id}`);
  console.log(`  ${r.lang || '언어 미표기'} · ★ ${r.stars.toLocaleString()} · 포크 ${r.forks.toLocaleString()} · 업데이트 ${r.updated}`);
  console.log(`\n  ${r.ko}`);
  if (r.desc) console.log(c.dim(`  ${r.desc}`));
  console.log(c.dim(`  로컬 등급: ${meta.levels[r.local]}`));
  if (p) {
    console.log(`\n${c.yellow('◆ 추천')} ${c.bold(p.tagline)}`);
    console.log(`  ${p.why}`);
    console.log(`\n  ${c.bold('얻는 결과물')}`);
    for (const o of p.outputs) console.log(`   • ${o}`);
    console.log(`\n  ${c.bold('해볼 만한 미니 프로젝트')}`);
    for (const m of p.minis) console.log(`   ${c.cyan('▸ ' + m.name)}\n     ${m.desc}`);
    console.log(`\n  ${c.bold('필요 도구')} ${p.requires.join(', ')} · 설치 규모 ${p.size}`);
    if (p.related) console.log(`  ${c.bold('같이 보기')} ${p.related.join(', ')}`);
  }
  const local = clonePath(r, opt);
  console.log(`\n  ${c.bold('시작하기')}`);
  if (p?.recipe.noClone) return console.log(`   cd <내 프로젝트> && repolab run ${shortName(r)}   ${c.dim('# 클론 없이 현재 폴더에서 실행')}\n`);
  console.log(`   repolab clone ${shortName(r)}     ${c.dim('# ' + local)}`);
  console.log(`   repolab run ${shortName(r)}       ${c.dim(p ? '# 검증된 실행 레시피' : '# 프로젝트 유형 자동 감지')}`);
  console.log();
}

function shortName(r) {
  const name = r.id.split('/')[1];
  return repos.filter((x) => x.id.split('/')[1].toLowerCase() === name.toLowerCase()).length === 1 ? name : r.id;
}

function cmdPicks(pos, opt) {
  if (opt.json) return console.log(JSON.stringify({ picks, mentions }, null, 2));
  console.log(c.bold(`\n◆ 직접 해볼 만한 ${picks.length}선\n`));
  picks.forEach((p, i) => {
    console.log(`${c.yellow(String(i + 1).padStart(2))}. ${c.bold(p.title)} ${c.dim('— ' + p.id)}`);
    console.log(`    ${p.tagline}`);
    console.log(c.dim(`    결과물: ${p.outputs[0]} · 미니: ${p.minis.map((m) => m.name).join(' / ')}`));
  });
  console.log(c.bold('\n그 밖에 볼 만한 것'));
  for (const m of mentions) console.log(`  · ${c.bold(m.id)} ${c.dim(m.note)}`);
  console.log(c.dim('\n자세히: repolab show <이름> · 실행: repolab run <이름>'));
}

function cmdCats() {
  const count = (key) => repos.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());
  console.log(c.bold('\n카테고리'));
  for (const [k, n] of [...count('cat')].sort((a, b) => b[1] - a[1])) console.log(`  ${fit(k, 16)} ${n}`);
  console.log(c.bold('\n로컬 실행 등급') + c.dim('  (--local 값)'));
  for (const [k, n] of [...count('local')].sort((a, b) => b[1] - a[1])) console.log(`  ${LEVEL_COLOR[k](fit(k, 9))} ${fit(n, 3)} ${c.dim(meta.levels[k])}`);
  console.log(c.bold('\n언어'));
  console.log('  ' + [...count('lang')].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k || '-'} ${n}`).join(' · '));
  console.log();
}

// ── 도구 탐지 ───────────────────────────────────────────────────────
const whichCache = new Map();
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  const found = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
  whichCache.set(cmd, found);
  return found;
}
function version(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: IS_WIN, timeout: 15000 });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null;
}

// 최소 버전 이상의 python 실행 파일을 찾는다 (Windows는 py 런처 우선)
function findPython(min = [3, 9]) {
  const cands = IS_WIN ? [['py', ['-3']], ['python', []], ['python3', []]] : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'].map((x) => [x, []]);
  for (const [cmd, pre] of cands) {
    if (!which(cmd)) continue;
    const v = version(cmd, [...pre, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])']);
    if (!v) continue;
    const [ma, mi] = v.split('.').map(Number);
    if (ma > min[0] || (ma === min[0] && mi >= min[1])) return [cmd, ...pre].join(' ');
  }
  return null;
}

function cmdDoctor() {
  const tools = [
    ['git', '클론에 필수'], ['node', 'JS/TS 프로젝트'], ['npm', 'JS/TS 프로젝트'], ['pnpm', 'pnpm 레포'], ['yarn', 'yarn 레포'], ['corepack', 'yarn/pnpm 버전 자동 맞춤'],
    ['cargo', 'Rust 레포'], ['uv', 'Python 도구 설치'], ['go', 'Go 레포'], ['java', 'Java 레포'], ['zig', 'Zig 레포'], ['cmake', 'C/C++ 레포'], ['docker', '셀프호스팅·무거운 레포'],
  ];
  console.log(c.bold(`\nrepolab doctor · ${platform()} · node ${process.version}\n`));
  for (const [t, why] of tools) {
    const v = which(t) ? version(t, t === 'java' ? ['-version'] : t === 'go' ? ['version'] : ['--version']) || '(버전 확인 실패)' : null;
    console.log(`  ${v ? c.green('✓') : c.dim('·')} ${fit(t, 9)} ${v ? fit(v, 44) : c.dim(fit('없음', 44))} ${c.dim(why)}`);
  }
  const py = findPython([3, 9]);
  console.log(`  ${py ? c.green('✓') : c.dim('·')} ${fit('python', 9)} ${py ? fit(`${py} (${version(py.split(' ')[0], [...py.split(' ').slice(1), '--version'])})`, 44) : c.dim(fit('3.9+ 없음', 44))} ${c.dim('Python 레포')}`);
  console.log(c.dim(`\n  클론 위치: ${baseDir({})}  (--dir 또는 REPOLAB_DIR로 변경)\n`));
  if (!which('git')) process.exitCode = 1;
}

// ── 클론 ────────────────────────────────────────────────────────────
function baseDir(opt) {
  return resolve(opt.dir || process.env.REPOLAB_DIR || join(ROOT, 'repos'));
}
function clonePath(r, opt) {
  return join(baseDir(opt), r.id.replace('/', '__'));
}
function runSync(cmd, args, cwd) {
  console.log(c.dim(`$ ${[cmd, ...args].join(' ')}`));
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) die(`${cmd} 실행 실패: ${r.error.message}`);
  return r.status ?? 1;
}

function ensureClone(r, opt) {
  if (!which('git')) die('git이 필요합니다. https://git-scm.com/downloads');
  const dest = clonePath(r, opt);
  if (existsSync(join(dest, '.git'))) {
    console.log(c.green('✓ ') + `이미 클론됨: ${dest}`);
    if (opt.update && runSync('git', ['-C', dest, 'pull', '--ff-only'], dest) !== 0) die('git pull 실패 (로컬 변경이 있으면 직접 정리하세요)');
    return dest;
  }
  if (existsSync(dest) && readdirSync(dest).length) die(`${dest} 가 이미 있고 git 저장소가 아닙니다. 확인 후 지우거나 --dir 로 다른 위치를 쓰세요.`);
  mkdirSync(baseDir(opt), { recursive: true });
  const args = ['clone', ...(opt.full ? [] : ['--depth', '1']), `https://github.com/${r.id}.git`, dest];
  if (runSync('git', args, baseDir(opt)) !== 0) die('git clone 실패. 레포가 비공개·삭제됐는지 repolab check 로 확인해 보세요.');
  console.log(c.green('✓ ') + `클론 완료: ${dest}`);
  return dest;
}

function cmdClone(pos, opt) {
  if (!pos.length) die('클론할 레포를 주세요. 예: repolab clone excalidraw');
  for (const q of pos) ensureClone(findRepo(q), opt);
}

function cmdPath(pos, opt) {
  console.log(clonePath(findRepo(pos[0]), opt));
}

// ── 존재 확인 (git ls-remote) ───────────────────────────────────────
function lsRemote(id) {
  return new Promise((res) => {
    const child = spawn('git', ['ls-remote', '--heads', `https://github.com/${id}.git`], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const timer = setTimeout(() => { child.kill(); res('timeout'); }, 20000);
    child.on('close', (code) => { clearTimeout(timer); res(code === 0 ? 'ok' : 'missing'); });
    child.on('error', () => { clearTimeout(timer); res('error'); });
  });
}
async function cmdCheck(pos, opt) {
  const list = pos.length ? pos.map(findRepo) : opt.all ? repos : picks.map((p) => findRepo(p.id));
  const jobs = Number(opt.jobs || 8);
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, list.length) }, async () => {
    while (i < list.length) {
      const r = list[i++];
      const s = await lsRemote(r.id);
      results.push([r.id, s]);
      console.log(`  ${s === 'ok' ? c.green('✓') : c.red('✗')} ${r.id}${s === 'ok' ? '' : c.dim(' — ' + s)}`);
    }
  }));
  const bad = results.filter(([, s]) => s !== 'ok').length;
  console.log(c.dim(`\n  ${results.length}개 중 접근 가능 ${results.length - bad}개${pos.length || opt.all ? '' : ' (전체는 --all)'}`));
  if (bad) process.exitCode = 1;
}

// ── 실행 계획 ───────────────────────────────────────────────────────
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// packageManager 필드에 맞는 yarn/pnpm 호출 방법을 고른다
function pmCommand(pm, dir) {
  const pkg = readJson(join(dir, 'package.json')) || {};
  const pinned = String(pkg.packageManager || '').match(/^(\w+)@(\d+)/);
  const major = pinned && pinned[1] === pm ? Number(pinned[2]) : null;
  if (pm === 'npm') return 'npm';
  if (pm === 'yarn' && major && major >= 2) {
    if (which('corepack')) return 'corepack yarn';
    if (which('yarn') && existsSync(join(dir, '.yarnrc.yml'))) return 'yarn';
    return { missing: `yarn ${major}이 필요합니다. npm install -g corepack 후 다시 실행하세요.` };
  }
  if (which(pm)) return pm;
  if (which('corepack')) return `corepack ${pm}`;
  return `npx -y ${pm}${major ? '@' + major : ''}`;
}

function detectPlan(dir) {
  const has = (f) => existsSync(join(dir, f));
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg) {
    const pm = String(pkg.packageManager || '').split('@')[0] || (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm');
    const scripts = pkg.scripts || {};
    const script = ['dev', 'start', 'serve', 'preview', 'storybook'].find((s) => scripts[s]);
    const p = `{${pm}}`;
    const steps = [`${p} install`];
    if (script) steps.push(pm === 'npm' ? `npm run ${script}` : `${p} ${script}`);
    else if (scripts.build) steps.push(pm === 'npm' ? 'npm run build' : `${p} build`);
    const bin = pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]);
    return { kind: `Node (${pm})`, steps, note: script ? `package.json의 "${script}" 스크립트를 실행합니다.` : bin ? `CLI 패키지입니다: node ${bin} --help` : `실행 스크립트가 없습니다. 사용 가능: ${Object.keys(scripts).join(', ') || '없음'}` };
  }
  if (has('Cargo.toml')) {
    const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    const rootPkg = /^\[package\]/m.test(toml);
    return { kind: 'Rust', steps: [rootPkg ? 'cargo run --release' : 'cargo build --release'], note: rootPkg ? '첫 빌드는 수 분 걸릴 수 있습니다.' : '워크스페이스입니다. 실행할 크레이트는 README에서 확인하세요 (cargo run -p <이름>).' };
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const install = has('requirements.txt') ? '{pip} install -r requirements.txt' : '{pip} install -e .';
    return { kind: 'Python', steps: ['{venv}', install], note: '.venv 가상환경에 설치합니다. 실행 명령은 README를 확인하세요.' };
  }
  if (has('go.mod')) return { kind: 'Go', steps: ['go build ./...'], note: '실행 진입점은 README 또는 cmd/ 폴더를 확인하세요.' };
  if (has('build.zig')) return { kind: 'Zig', steps: ['zig build'], note: '' };
  if (has('gradlew')) return { kind: 'Java (Gradle)', steps: [IS_WIN ? 'gradlew.bat build' : './gradlew build'], note: '' };
  if (has('pom.xml')) return { kind: 'Java (Maven)', steps: ['mvn package'], note: '' };
  if (has('CMakeLists.txt')) return { kind: 'C/C++ (CMake)', steps: ['cmake -B build -DCMAKE_BUILD_TYPE=Release', 'cmake --build build --config Release'], note: '' };
  for (const f of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    if (has(f)) return { kind: 'Docker Compose', steps: ['docker compose up'], note: 'Docker가 필요합니다.' };
  }
  if (has('index.html')) return { kind: '정적 사이트', steps: [], serve: '.', note: '내장 정적 서버로 띄웁니다.' };
  if (has('SKILL.md') || has('skills')) return { kind: '에이전트 스킬', steps: [], note: 'Claude Code·Codex 등에 스킬로 설치해 쓰는 레포입니다. README의 설치 방법을 따르세요.' };
  return { kind: '알 수 없음', steps: [], note: 'README를 확인하세요.' };
}

// 레시피의 {npm}/{yarn}/{pnpm}/{py}/{pip}/{venv}/{repolab} 자리표시자를 실제 명령으로 바꾼다
function resolveSteps(steps, dir) {
  const venvPy = join(dir, '.venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');
  const q = (p) => (p.includes(' ') ? `"${p}"` : p);
  const out = [];
  for (const s of steps) {
    if (s === '{venv}') {
      if (existsSync(venvPy)) continue;
      const py = findPython([3, 9]);
      if (!py) return { error: 'Python 3.9 이상이 필요합니다. https://www.python.org/downloads/' };
      out.push(`${py} -m venv .venv`);
      continue;
    }
    let cmd = s.replace(/\{py\}/g, q(venvPy)).replace(/\{pip\}/g, `${q(venvPy)} -m pip`).replace(/\{repolab\}/g, q(ROOT));
    for (const pm of ['npm', 'yarn', 'pnpm', 'bun']) {
      if (!cmd.includes(`{${pm}}`)) continue;
      const r = pmCommand(pm, dir);
      if (typeof r === 'object') return { error: r.missing };
      cmd = cmd.replaceAll(`{${pm}}`, r);
    }
    out.push(cmd);
  }
  return { steps: out };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes' || a === 'ㅛ';
}

async function cmdRun(pos, opt) {
  const r = findRepo(pos[0]);
  const p = pickById.get(r.id);
  // noClone 레시피(예: react-doctor)는 레포를 받지 않고 현재 폴더에서 돈다
  const dir = p?.recipe.noClone ? process.cwd() : opt['dry-run'] && !existsSync(clonePath(r, opt)) ? null : ensureClone(r, opt);
  if (!dir) {
    console.log(c.dim(`(dry-run) 아직 클론되지 않음 → git clone --depth 1 https://github.com/${r.id}.git ${clonePath(r, opt)}`));
    if (!p) return console.log(c.dim('(dry-run) 실행 계획은 클론 후 프로젝트 파일을 보고 정합니다.'));
  }
  const plan = p ? { kind: '추천 레시피', ...p.recipe, steps: (IS_WIN && p.recipe.win) || p.recipe.steps } : detectPlan(dir);
  const resolved = resolveSteps(plan.steps, dir || clonePath(r, opt));
  console.log(`\n${c.bold('실행 계획')} ${c.dim(`(${plan.kind})`)}  ${c.dim(dir || clonePath(r, opt))}`);
  if (resolved.error) die(resolved.error);
  resolved.steps.forEach((s, i) => console.log(`  ${i + 1}. ${c.cyan(s)}`));
  if (plan.serve) console.log(`  ${resolved.steps.length + 1}. ${c.cyan(`repolab serve ${shortName(r)}`)} ${c.dim('(내장 정적 서버)')}`);
  if (plan.note) console.log(c.dim(`  ※ ${plan.note}`));
  if (!resolved.steps.length && !plan.serve) return;
  if (opt['dry-run']) return;
  if (r.local !== 'ready') console.log(c.yellow(`  ! 로컬 등급: ${meta.levels[r.local]}`));
  console.log(c.yellow('  ! 외부 저장소의 코드를 내 컴퓨터에서 실행합니다. 처음 보는 레포라면 먼저 내용을 확인하세요.'));
  if (!opt.yes && !(await confirm('\n진행할까요? [Y/n] '))) {
    console.log(c.dim(process.stdin.isTTY ? '취소했습니다.' : '대화형 터미널이 아니라 확인을 받을 수 없습니다. --yes 를 붙이면 바로 실행합니다.'));
    return;
  }
  for (const step of resolved.steps) {
    console.log(c.dim(`\n$ ${step}`));
    const res = spawnSync(step, { cwd: dir, stdio: 'inherit', shell: true });
    // okCodes: 이슈를 찾으면 1로 끝나는 검사 도구(react-doctor)처럼 0이 아닌 정상 종료가 있다
    if (!(plan.okCodes || [0]).includes(res.status)) die(`"${step}" 가 종료 코드 ${res.status ?? res.signal}로 실패했습니다. 위 로그를 확인하세요.`, res.status || 1);
  }
  if (plan.serve) await serveDir(join(dir, plan.serve), opt);
}

// ── 정적 서버 ───────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.fold': 'application/json', '.obj': 'text/plain', '.stl': 'model/stl', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

function serveDir(root, opt) {
  root = resolve(root);
  const port = Number(opt.port || 8080);
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      let rel;
      try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { resp.writeHead(400).end(); return; }
      let file = normalize(join(root, rel));
      if (file !== root && !file.startsWith(root + sep)) { resp.writeHead(403).end('forbidden'); return; }
      if (existsSync(file) && statSync(file).isDirectory()) {
        // index.html이 없는 폴더(예: anatomy examples/)는 파일 목록을 보여 준다
        if (!existsSync(join(file, 'index.html'))) {
          const base = rel.endsWith('/') ? rel : rel + '/';
          const items = readdirSync(file, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => `<li><a href="${esc(encodeURI(base) + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : ''))}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('');
          resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>${esc(base)}</title><h1>${esc(base)}</h1><ul>${items}</ul>`);
          return;
        }
        file = join(file, 'index.html');
      }
      if (!existsSync(file)) { resp.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 없음'); return; }
      resp.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      createReadStream(file).pipe(resp);
    });
    server.on('error', (e) => die(e.code === 'EADDRINUSE' ? `포트 ${port}가 사용 중입니다. --port 로 바꾸세요.` : e.message));
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`\n${c.green('●')} ${root}\n  ${c.bold(url)}  ${c.dim('(Ctrl+C로 종료)')}`);
      if (opt.open) openUrl(url);
    });
    process.on('SIGINT', () => { server.close(); res(); process.exit(0); });
  });
}

async function cmdServe(pos, opt) {
  const target = pos[0];
  if (!target) die('대상을 주세요. 예: repolab serve OrigamiSimulator · repolab serve ./site');
  if (existsSync(target)) return serveDir(target, opt);
  const r = findRepo(target);
  const dir = clonePath(r, opt);
  if (!existsSync(dir)) die(`아직 클론되지 않았습니다: repolab clone ${shortName(r)}`);
  const sub = pickById.get(r.id)?.recipe.serve || '.';
  return serveDir(join(dir, sub), opt);
}

// ── 브라우저 열기 ───────────────────────────────────────────────────
function openUrl(url) {
  const [cmd, args] = IS_WIN ? ['cmd', ['/c', 'start', '""', url]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.log(`브라우저를 열지 못했습니다: ${url}`)).unref();
}
function cmdOpen(pos, opt) {
  if (opt.site || !pos.length) {
    const f = join(ROOT, 'site/index.html');
    if (!existsSync(f)) die('site/index.html이 없습니다. repolab html 로 먼저 만드세요.');
    return openUrl(IS_WIN ? f : `file://${f}`);
  }
  const r = findRepo(pos[0]);
  openUrl(`https://github.com/${r.id}`);
}

// ── HTML 생성 ───────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function cmdHtml(pos, opt) {
  const out = resolve(opt.out || join(ROOT, 'site/index.html'));
  const template = readFileSync(join(ROOT, 'site/template.html'), 'utf8');
  const cards = picks.map((p, i) => {
    const r = findRepo(p.id);
    const art = readFileSync(join(ROOT, 'site/art', p.art), 'utf8').replace(/<\?xml[^>]*>\s*/, '').replace('<svg ', `<svg role="img" aria-label="${esc(p.title)} 결과물 예시" `);
    return `<article class="pick" id="pick-${i + 1}" data-id="${esc(p.id)}">
  <figure class="pick-art">${art}</figure>
  <div class="pick-body">
    <p class="pick-meta"><span class="num">${String(i + 1).padStart(2, '0')}</span> <a href="https://github.com/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.id)}</a> <span class="lv lv-${r.local}">${esc(LEVEL_LABEL[r.local])}</span> <span class="muted">${esc(r.lang)} · ★ ${fmtNum(r.stars)}</span></p>
    <h3>${esc(p.title)}</h3>
    <p class="tagline">${esc(p.tagline)}</p>
    <p class="why">${esc(p.why)}</p>
    <h4>얻는 결과물</h4>
    <ul class="outputs">${p.outputs.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
    <h4>해볼 만한 미니 프로젝트</h4>
    <ul class="minis">${p.minis.map((m) => `<li><b>${esc(m.name)}</b><span>${esc(m.desc)}</span></li>`).join('')}</ul>
    <p class="req"><span>필요: ${esc(p.requires.join(', '))}</span><span>설치 규모: ${esc(p.size)}</span>${p.related ? `<span>같이 보기: ${p.related.map(esc).join(', ')}</span>` : ''}</p>
    <div class="cmd"><code>repolab run ${esc(shortName(r))}</code><button type="button" class="copy" data-copy="repolab run ${esc(shortName(r))}">복사</button></div>
  </div>
</article>`;
  }).join('\n');
  const mentionHtml = mentions.map((m) => `<li><a href="https://github.com/${esc(m.id)}" target="_blank" rel="noopener">${esc(m.id)}</a><span>${esc(m.note)}</span></li>`).join('');
  const counts = repos.reduce((m, r) => ({ ...m, [r.local]: (m[r.local] || 0) + 1 }), {});
  const data = JSON.stringify({ meta, repos, picks: picks.map((p) => p.id), labels: LEVEL_LABEL }).replace(/</g, '\\u003c');
  const html = template
    .replace('<!--PICKS-->', cards)
    .replaceAll('<!--NPICKS-->', String(picks.length))
    .replace('<!--MENTIONS-->', mentionHtml)
    .replaceAll('<!--TOTAL-->', String(repos.length))
    .replaceAll('<!--READY-->', String(counts.ready || 0))
    .replaceAll('<!--SKILL-->', String(counts.skill || 0))
    .replaceAll('<!--COLLECTED-->', esc(meta.collected))
    .replace('/*DATA*/null', data);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(c.green('✓ ') + `${out} (${(html.length / 1024).toFixed(0)} KB, 레포 ${repos.length}개 · 추천 ${picks.length}개)`);
  if (opt.open) openUrl(IS_WIN ? out : `file://${out}`);
}

// ── 도움말 ──────────────────────────────────────────────────────────
const HELP = `${c.bold('repolab')} — 트렌딩 레포 ${repos.length}개 검색 · 클론 · 실행 도우미

${c.bold('찾아보기')}
  repolab list [--cat 문서] [--local ready,heavy] [--lang Rust] [--picks] [--sort stars|forks|name] [--limit N] [--json]
  repolab search <검색어...>       이름·설명·카테고리에서 AND 검색 (예: search hwp markdown)
  repolab show <이름>              상세 정보, 결과물, 미니 프로젝트
  repolab picks                    직접 해볼 만한 추천작
  repolab cats                     카테고리·로컬 등급·언어별 개수

${c.bold('가져와서 돌려 보기')}
  repolab doctor                   git/node/cargo/python 등 설치 여부 점검
  repolab check [이름...] [--all]  GitHub에 레포가 실제로 있는지 확인 (기본: 추천작)
  repolab clone <이름...> [--full] [--update]   얕은 클론 (기본 위치 프로젝트 폴더의 repos/)
  repolab run <이름> [--yes] [--dry-run]        클론 → 설치 → 실행 (추천작은 검증된 레시피)
  repolab serve <이름|폴더> [--port 8080] [--open]  내장 정적 서버
  repolab path <이름>              로컬 클론 경로 출력
  repolab open [이름]              GitHub 페이지 열기 (이름 없으면 소개 HTML)
  repolab html [--out 파일] [--open]   소개 페이지 site/index.html 생성

${c.bold('공통 옵션')}
  --dir <폴더>    클론 위치 (환경변수 REPOLAB_DIR도 가능)
  NO_COLOR=1      색상 끄기

이름은 전체(owner/repo), 레포 이름, 고유한 일부분 모두 됩니다. 예: repolab show origami
`;

const COMMANDS = { list: cmdList, ls: cmdList, search: cmdSearch, find: cmdSearch, show: cmdShow, info: cmdShow, picks: cmdPicks, cats: cmdCats, doctor: cmdDoctor, check: cmdCheck, clone: cmdClone, run: cmdRun, serve: cmdServe, path: cmdPath, open: cmdOpen, html: cmdHtml };

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || opt.help) {
  console.log(HELP);
} else if (!COMMANDS[cmd]) {
  die(`알 수 없는 명령: ${cmd}\n  repolab help 로 사용법을 보세요.`);
} else {
  await COMMANDS[cmd](pos, opt);
}
