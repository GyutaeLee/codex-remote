# Operations

## 요구 사항

- macOS
- Node.js 18+
- `codex`
- `tmux`
- `cloudflared`

## 최초 설정

```bash
brew install tmux cloudflared
cp .env.example .env
npm install
codex --help
```

`.env`에서는 최소 `AUTH_TOKEN`을 설정한다.

## 평소 실행

열기:

```bash
npm run open
```

닫기:

```bash
npm run close
```

`open` 출력에는 보통 아래가 포함된다.

- 로컬 URL
- public URL (`https://...trycloudflare.com`)
- 서버 PID
- 로그 파일 경로

## 사용 순서

1. Mac의 `Terminal.app` 또는 `iTerm`에서 `npm run open`
2. 출력된 public URL을 모바일 브라우저에서 열기
3. `.env`의 `AUTH_TOKEN`으로 로그인
4. 사용이 끝나면 `npm run close`

## 로그와 런타임 파일

- `run/server.log`
- `run/tunnel.log`
- `run/server.pid`
- `run/tunnel.pid`

## 중요한 운영 규칙

- `npm run open`은 Codex 앱 내부 터미널에서 실행하지 않는다.
- 기본 운영은 Quick Tunnel이다. URL은 매번 바뀔 수 있다.
- 터널이 열려 있는 동안은 공개 엔드포인트다. 안 쓸 때는 닫는다.
- `AUTH_TOKEN`은 길고 랜덤한 값으로 유지한다.

## 자주 생기는 문제

### `502 Bad Gateway`

- `run/server.log`를 먼저 본다
- 서버가 완전히 뜨기 전에 터널 URL을 연 경우 몇 초 후 다시 시도한다
- 필요하면 `npm run close` 후 `npm run open`을 다시 실행한다

### `Codex cannot access session files` 또는 readonly DB 오류

가장 흔한 원인은 Codex 앱 내부 샌드박스에서 서버를 띄운 경우다.

- `Terminal.app` 또는 `iTerm`에서 다시 `npm run open`
- 그래도 반복되면 `~/.codex` 권한을 확인

권한이 실제로 꼬였을 때만:

```bash
sudo chown -R $(whoami) ~/.codex
```

### 로그인 실패

- `.env`의 `AUTH_TOKEN` 값을 다시 확인
- 토큰을 바꿨다면 서버를 다시 연다

### `tmux` 또는 `codex`를 찾지 못함

```bash
brew install tmux cloudflared
codex --help
```

## 개발 중 최소 점검

바꾼 JS 파일은 최소한 아래처럼 확인한다.

```bash
node --check src/server.js
node --check public/app.js
```

필요한 파일만 골라서 돌리면 된다.
