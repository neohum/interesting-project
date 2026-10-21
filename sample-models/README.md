# sample-models — Mesh2Motion에 올려 볼 무료 GLB

[Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app)의 **"Use Your Model"(`/create.html`)** 에서 바로 리깅·애니메이션을 입혀 볼 수 있는 뼈대 없는 3D 모델 9개다.

- 출처: `Mesh2Motion/mesh2motion-app`의 `static/models/`
- 라이선스: **CC0 1.0** (3D 모델·리그·애니메이션 등 아트 에셋). 상업적 이용·수정·재배포 모두 자유. 전문은 `LICENSE-CC0.md`. (앱 코드는 MIT이며 이 폴더에는 포함되지 않는다.)
- 모두 스킨(뼈대)이 없는 순수 메시라 업로드 → 리깅 흐름을 그대로 체험할 수 있다.

| 파일 | 종류 | Mesh2Motion에서 고를 스켈레톤 |
|---|---|---|
| `model-human.glb` | 사람 | Human |
| `model-fox.glb` | 여우 (네발) | Fox |
| `model-horse.glb` | 말 | Horse |
| `model-bird.glb` | 새 | Bird |
| `model-dragon.glb` | 드래곤 | Dragon |
| `model-kaiju.glb` | 괴수 | Kaiju |
| `model-shark.glb` | 상어 | Shark |
| `model-snake.glb` | 뱀 | Snake |
| `model-spider.glb` | 거미 | Spider |

## 써보기

```bash
repolab run mesh2motion-app      # 클론 → 설치 → 개발 서버 (보통 http://localhost:5173)
```

1. 브라우저에서 `http://localhost:5173/create.html` 을 연다.
2. 이 폴더의 `.glb` 하나를 올린다 (예: `model-human.glb`).
3. 화면 안내에 따라 같은 종류의 스켈레톤을 고르고, 뼈대 위치를 모델에 맞춘 뒤 리깅(스키닝)한다.
4. 걷기·달리기 같은 애니메이션을 고르고 GLB로 내보낸다.

사람 모델은 T자 포즈로 서 있는 모델이 잘 맞는다. 직접 만든 모델을 쓰려면 Blender 등에서 GLB로 내보내 올리면 된다.
