# Architecture

## 목표

브라우저에서 Codex를 쓰되, 요청마다 새 CLI를 띄우지 않고 macOS의 유지형 `tmux` 세션과 기존 Codex 상태를 그대로 사용한다.

## 주요 구성 요소

- `scripts/open.js`
  - 서버 시작
  - Cloudflare Quick Tunnel 시작
  - URL, PID, 로그 경로 출력
- `scripts/close.js`
  - 서버/터널 종료
  - PID 파일과 런타임 파일 정리
- `src/server.js`
  - Express 진입점
  - 인증, rate limit, 보안 헤더
  - REST API와 SSE 이벤트 제공
- `src/auth.js`
  - `AUTH_TOKEN` 검증
  - 세션 쿠키 발급/검증
- `src/codex-app-server.js`
  - Codex App Server JSON-RPC 호출
  - thread list/read/start/resume/turn 제어
- `src/codex-native.js`
  - `~/.codex`의 프로젝트/고정 스레드 정보와 App Server 결과를 조합
  - UI에 필요한 프로젝트/스레드/메시지 형태로 정리
- `src/live-runtime.js`
  - live turn 상태 보관
  - approval, 추가 입력, terminal input 상태 관리
- `src/tmux.js`
  - 세션 이름 `codex`를 유지
  - interactive prompt 감지와 보조 제어 담당
- `public/`
  - 반응형 UI
  - 모바일은 ChatGPT App 쪽 사용성
  - 데스크톱은 Codex App 쪽 사용성

## 데이터 흐름

1. 운영자가 `npm run open` 실행
2. 서버가 로컬 `127.0.0.1`에 올라오고 Quick Tunnel이 외부 URL을 생성
3. 브라우저가 로그인 후 프로젝트/스레드 목록을 요청
4. 서버는 `NativeCodexStore`로 현재 Codex 상태를 읽음
5. 사용자가 메시지를 보내면 서버는 직렬 큐를 통해 turn을 시작
6. live 상태는 `LiveRuntime`이 관리하고, 브라우저는 SSE로 갱신을 받음
7. 필요 시 approval / user input / terminal input을 웹에서 다시 보냄

## 현재 source of truth

- 프로젝트/스레드/고정 스레드: `~/.codex/.codex-global-state.json` + Codex App Server
- live turn 상태: 서버 메모리의 `LiveRuntime`
- 실행 로그와 PID: `run/`

참고:

- `src/history.js`는 현재 서버 경로에서 사용하지 않는다.
- `data/history.json`은 현재 주 흐름의 source of truth가 아니다.

## 바꾸면 안 되는 규칙

- `tmux` 기반 유지 세션을 제거하지 않는다.
- 요청마다 `codex ...`를 새로 실행하는 1회성 구조로 바꾸지 않는다.
- API 응답은 계속 JSON 기반으로 유지한다.
- Quick Tunnel on-demand 운영을 기본값으로 유지한다.

## 자주 만지는 파일

- 인증/보안: `src/auth.js`, `src/server.js`, `src/rate-limit.js`
- live turn 동작: `src/live-runtime.js`, `src/codex-app-server.js`, `src/tmux.js`
- 프로젝트/스레드 목록: `src/codex-native.js`
- 화면/UI: `public/index.html`, `public/styles.css`, `public/app.js`
