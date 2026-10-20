import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/repolab.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const { repos } = JSON.parse(readFileSync(join(ROOT, 'data/repos.json'), 'utf8'));
const { picks, mentions } = JSON.parse(readFileSync(join(ROOT, 'data/picks.json'), 'utf8'));

test('데이터: 90개, id 중복 없음, 추천작은 모두 목록과 그림이 있다', () => {
  assert.equal(repos.length, 90);
  assert.equal(new Set(repos.map((r) => r.id)).size, 90);
  const ids = new Set(repos.map((r) => r.id));
  for (const p of picks) {
    assert.ok(ids.has(p.id), p.id);
    assert.ok(existsSync(join(ROOT, 'site/art', p.art)), p.art);
    assert.ok(repos.find((r) => r.id === p.id).pick, `${p.id} pick 플래그`);
  }
  assert.equal(repos.filter((r) => r.pick).length, picks.length);
  for (const m of mentions) assert.ok(ids.has(m.id), m.id);
});

test('search는 AND 검색이고 JSON을 낸다', () => {
  const out = JSON.parse(run('search', 'hwp', 'markdown', '--json').stdout);
  assert.ok(out.some((r) => r.id === 'chrisryugj/kordoc'));
  assert.ok(out.every((r) => `${r.id} ${r.ko} ${r.desc} ${r.cat}`.toLowerCase().includes('hwp')));
});

test('list 필터와 정렬', () => {
  const out = JSON.parse(run('list', '--local', 'ready', '--lang', 'Rust', '--json').stdout);
  assert.ok(out.length > 0 && out.every((r) => r.local === 'ready' && r.lang === 'Rust'));
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].stars >= out[i].stars);
});

test('show는 부분 이름을 풀고, 모호하면 후보를 보여 주며 실패한다', () => {
  assert.match(run('show', 'origami').stdout, /amandaghassaei\/OrigamiSimulator/);
  const amb = run('show', 'hwpx');
  assert.equal(amb.status, 1);
  assert.match(amb.stderr, /여러 개/);
  assert.equal(run('show', 'zzz-none').status, 1);
});

test('run --dry-run은 클론 없이 계획만 보여 준다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repolab-'));
  const r = run('run', 'ClaudeAnimationBase', '--dry-run', '--dir', dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /render\.mjs --clip/);
  assert.ok(!existsSync(join(dir, 'JohnHeibel__ClaudeAnimationBase')));
});

test('html은 추천 카드와 데이터가 들어간 페이지를 만든다', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'repolab-')), 'index.html');
  assert.equal(run('html', '--out', out).status, 0);
  const html = readFileSync(out, 'utf8');
  assert.equal((html.match(/<article class="pick"/g) || []).length, picks.length);
  assert.ok(!html.includes('<!--PICKS-->') && !html.includes('/*DATA*/null'));
  assert.match(html, /<html lang="ko">/);
});

test('알 수 없는 명령은 실패한다', () => {
  assert.equal(run('nope').status, 1);
});
