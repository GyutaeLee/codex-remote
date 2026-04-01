# Copilot Instructions

- `README.md`는 사람용 빠른 사용 문서로 짧게 유지한다.
- 깊은 설명은 `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`로 분리한다.
- `tmux` 기반 유지 세션 구조를 유지한다. 요청마다 새 `codex`를 실행하지 않는다.
- 기본 운영 흐름은 `npm run open` / `npm run close`다.
- JS를 수정했으면 바꾼 파일에 대해 `node --check`를 돌린다.
