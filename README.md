# repolab

GitHub 트렌딩 레포 90개를 실행 조건별로 정리하고, 그중 애니메이션·그림·영상을 직접 만들어 볼 6개를 골라 결과물과 미니 프로젝트를 소개한다.

- 🌐 **소개 페이지: https://neohum.github.io/interesting-project/** (설치 없이 바로 열기)
- `site/index.html` — 소개 페이지 (추천 6선 일러스트, 전체 목록 검색·필터, CLI 사용법)
- `bin/repolab.mjs` — 목록 검색 · 클론 · 실행 CLI (의존성 없음, Node 18+ · git)
- `data/repos.json`, `data/picks.json` — 원본 데이터. 고친 뒤 `repolab html`로 페이지를 다시 만든다.

## 빠른 시작

```bash
node bin/repolab.mjs help
npm link                       # 이후 어디서나 repolab
repolab doctor                 # 설치된 도구 점검
repolab picks                  # 추천 6선
repolab search hwp markdown
repolab run ClaudeAnimationBase  # 클론 → 설치 → 데모 영상 렌더링 (실행 전 확인)
repolab run anatomy            # 예제 갤러리를 내장 정적 서버로 띄움
repolab open                   # 소개 페이지 열기
```

클론 위치는 기본 `~/repolab`이고 `--dir` 또는 `REPOLAB_DIR`로 바꾼다. Windows에서는 `py -3`, `.venv\Scripts`, `cmd /c start`를 자동으로 쓴다.

## 데이터에 대해

- 별·포크·업데이트는 붙여 넣은 목록의 2026-10-20 스냅샷이다.
- `local` 등급(ready/heavy/gpu/apple/key/skill/unknown)은 설명과 매니페스트를 보고 내린 판단이다.
- 추천작 레시피는 각 README·package.json으로 확인했고, `repolab check --all`로 90개 레포 모두 접근 가능한 것을 확인했다.
- 카드 그림은 결과물 형태를 그린 일러스트이며 실제 스크린샷이 아니다.

## 테스트

```bash
npm test
```
