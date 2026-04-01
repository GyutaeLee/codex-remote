# AGENTS.md

이 저장소의 문서 구조는 단순하다.

- `README.md`: 사람이 바로 쓰는 빠른 사용 문서
- `docs/OPERATIONS.md`: 설치, 실행, 로그, 트러블슈팅
- `docs/ARCHITECTURE.md`: 구성 요소와 데이터 흐름

## 먼저 읽을 것

1. `README.md`
2. 작업 범위가 서버/운영이면 `docs/OPERATIONS.md`
3. 구조 변경이나 버그 수정이면 `docs/ARCHITECTURE.md`

## 저장소 지도

- `scripts/open.js`: 서버와 Quick Tunnel 시작
- `scripts/close.js`: 서버와 터널 종료
- `src/server.js`: Express API, SSE, 인증, rate limit
- `src/auth.js`: Bearer token 검증과 세션 쿠키
- `src/codex-app-server.js`: Codex App Server JSON-RPC 클라이언트
- `src/codex-native.js`: Codex 프로젝트/스레드/고정 스레드 조회
- `src/live-runtime.js`: live turn 상태, approval, user input, terminal input
- `src/tmux.js`: 유지되는 `tmux` 세션 `codex` 브리지
- `public/`: 데스크톱은 Codex App 느낌, 모바일은 ChatGPT App 느낌의 UI

## 현재 구조에서 중요한 규칙

- `tmux`를 제거하지 않는다.
- 요청마다 새 `codex` 프로세스를 띄우지 않는다.
- 유지 세션 이름은 `codex`로 유지한다.
- 기본 운영 방식은 `npm run open` / `npm run close` + Quick Tunnel이다.
- `README.md`는 짧게 유지하고, 깊은 내용은 `docs/`로 보낸다.
- `src/history.js`는 현재 서버 진입점에서 쓰이지 않는다. 먼저 실제 참조 여부를 확인하고 만진다.

## 변경 후 점검

- 바꾼 JS 파일은 `node --check <file>`로 최소 문법 점검
- 서버/API 변경이면 `src/server.js`도 함께 점검
- 실제 `npm run open` 검증은 Codex 앱 내부 터미널이 아니라 macOS 일반 터미널에서 해야 한다

## 문서 수정 원칙

- `README.md`는 1분 안에 읽히게 유지
- 운영 절차, 로그 위치, 복구 방법은 `docs/OPERATIONS.md`
- 구조, 모듈 역할, 데이터 흐름은 `docs/ARCHITECTURE.md`
