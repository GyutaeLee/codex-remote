# codex-remote

macOS에서 돌아가는 Codex CLI를 `tmux`에 유지한 채, 모바일/다른 PC 브라우저에서 쓰는 원격 웹 UI다.

## 평소 사용

```bash
npm run open
npm run close
```

## 처음 한 번만

```bash
brew install tmux cloudflared
cp .env.example .env
npm install
codex --help
```

## 모바일에서 쓰는 순서

1. Mac의 `Terminal.app` 또는 `iTerm`에서 `npm run open`
2. 출력된 `https://...trycloudflare.com` 주소를 모바일 브라우저에서 열기
3. 로그인 화면에서 `.env`의 `AUTH_TOKEN` 입력
4. 다 썼으면 `npm run close`

## 꼭 알아둘 점

- 기본 운영 방식은 Cloudflare Quick Tunnel이다. URL은 `open` 할 때마다 바뀐다.
- 터널이 열려 있는 동안은 공개 엔드포인트다. 안 쓸 때는 `close` 하는 게 맞다.
- `npm run open`은 Codex 앱 내부 터미널이 아니라 일반 터미널에서 실행해야 한다.
- `AUTH_TOKEN`은 길고 추측 어려운 값으로 유지한다.

## 더 자세한 문서

- [운영 가이드](docs/OPERATIONS.md)
- [구조 설명](docs/ARCHITECTURE.md)
- [에이전트 작업 가이드](AGENTS.md)
