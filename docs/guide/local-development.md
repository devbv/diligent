# 로컬 개발/통합 테스트 가이드

웹 백엔드 · 프론트엔드 · 사이드카(스튜디오 연동)를 로컬에서 띄워 테스트하는 방법을 정리한다.

## 구성 개요

런타임은 3개의 프로세스로 나뉜다.

```
브라우저(5174, Vite)  ──HTTP/HMR──▶  Vite dev 서버
        │
        └── /rpc (WebSocket) ──프록시──▶  백엔드 RPC 서버 (7433)
                                              │
                                              └── (사이드카만) TCP ──▶ OVERDARE Studio (STUDIO_PORT, 기본 13377)
```

백엔드는 두 가지 중 하나로 띄운다. **둘 다 같은 web UI(채팅 화면)를 7433에 띄우는 web 서버**이고, 차이는 *Studio 연동 도구가 붙느냐*뿐이다.

| 백엔드 | 진입점 | Studio 도구 | web UI | 스토어 | 용도 |
| --- | --- | --- | --- | --- | --- |
| **web 단독** (Studio 도구 없음) | `packages/web/src/server/index.ts` | ❌ 없음 (`bundledToolProviders: []`) | ✅ 뜸 | `.diligent` | 웹 UI 작업만 |
| **사이드카** (OVERDARE 에이전트) | `apps/overdare-ai-agent/sidecar/src/server.ts` | ✅ `studiorpc_*` | ✅ 뜸 | `.overdare` | Studio 연동 테스트 |

> 핵심: "web 단독"은 *web만 띄운다*는 뜻이 아니라 **Studio 도구가 없는 백엔드**라는 뜻이다. `bun run web:dev`에는 `studiorpc_*`가 **로드되지 않으므로**, Studio 연동을 보려면 사이드카 진입점을 써야 한다. (사이드카도 web 서버다 — `@diligent/web`을 감싸고 studio 도구만 더 얹은 것)

Vite는 `/rpc`를 `ws://localhost:7433`으로 프록시하므로(`packages/web/vite.config.ts`), 백엔드는 **둘 중 무엇이든 7433에 띄우면** 프론트가 그대로 붙는다.

### Make 타깃 매핑

| 하고 싶은 것 | 한 줄 명령 | 수동(아래 모드 참고) |
| --- | --- | --- |
| web 단독 백엔드 | `bun run web:dev` | 모드 A |
| 프론트(Vite) | `make web-dev` | 모드 A·B 공통 |
| 사이드카 + 프론트 (로컬 Studio) | **`make dev-agent`** | 모드 B |
| 사이드카 + 프론트 (원격 Studio) | **`make dev-cross`** | [`mac-agent-windows-studio.md`](./mac-agent-windows-studio.md) |

---

## 사전 준비

```bash
bun install
```

- AI provider(채팅 실행용): 앱 UI의 `Config → AI connection`에서 연결하거나, 자격증명이 keychain/`.env.local`에 있으면 자동 사용.
- 대화 기록·스킬·설정은 `--cwd`(기본 `process.cwd()`) 아래 스토어 폴더에 저장된다. 폴더명은 진입점에 따라 다르다:
  - **모드 A(web 단독)** → `<cwd>/.diligent/` (브랜드 중립 런타임 기본)
  - **모드 B(사이드카)** → `<cwd>/.overdare/` (OVERDARE 앱이 `server.ts`에서 자동 보정)

---

## 모드 A — web 단독 (Studio 도구 없이 UI만)

웹 UI 변경(코드블록, 복사 버튼, Config 패널 등)만 볼 때 가장 가볍다. (`studiorpc_*` 도구는 안 붙는다.)

```bash
# 터미널 1 — web 단독 백엔드 RPC (7433)
bun run web:dev
#   = bun run packages/web/src/server/index.ts --dev
#   포트 미지정 시 기본 7433

# 터미널 2 — 프론트 (Vite, 5174)
make web-dev
#   = bun run --cwd packages/web dev
```

브라우저: **http://localhost:5174**

---

## 모드 B — 사이드카 (Studio 연동 포함)

`studiorpc_*` 도구가 붙고, Studio와 TCP로 통신한다. 스토어는 `.overdare`.

**권장: 한 명령** (사이드카 + Vite 동시 실행, 포트 정리·번들 스킬 심링크·`.overdare` 보정 자동):

```bash
make dev-agent                 # 로컬 Studio(localhost) 연결
#   Studio가 다른 머신이면 → make dev-cross (mac-agent-windows-studio.md 참고)
```

**수동(동작 원리 이해용, 터미널 2개):**

```bash
# 터미널 1 — 사이드카 백엔드 (7433) + STUDIO_PORT
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$(pwd)"

# 터미널 2 — 프론트 (Vite, 5174) — 모드 A와 동일
make web-dev
```

브라우저: **http://localhost:5174**

스튜디오 관련 추가 env(필요한 도구를 쓸 때만):

```bash
STUDIO_PORT=13377 \
STUDIO_HOST=localhost \          # 스튜디오가 다른 호스트일 때
HUB_DOMAIN=hub.example.com \     # hub token / publish 계열 도구
OVERDARE_PROJECT_ID=proj-123 \   # 프로젝트 스코프 도구
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$(pwd)"
```

> ⚠️ **OVERDARE Studio(에디터) 쪽이 해당 포트로 RPC를 리슨하고 있어야** 연결된다. dev에서는 로컬 Studio가 실제 리슨 중인 포트를 `STUDIO_PORT`에 넣는다.

---

## 포트 / 환경변수 레퍼런스

| 항목 | 값 | 비고 |
| --- | --- | --- |
| Vite 프론트 | `5174` | `packages/web/vite.config.ts`의 `server.port` |
| 백엔드 RPC | `7433` | `--port=`로 변경, 미지정 시 기본값. Vite 프록시 대상 |
| Studio RPC | `13377` | `STUDIO_PORT`로 변경, 미지정 시 기본값 |

백엔드 공통 인자(`parseArgs`, 두 진입점 동일):

| 인자 | 의미 |
| --- | --- |
| `--port=N` | 백엔드 HTTP/WS 포트 (기본 7433) |
| `--dev` | dev 모드(정적 파일 서빙 안 함, 프론트는 Vite가 담당) |
| `--cwd=PATH` | 작업 디렉터리(세션·설정 기준 경로) |
| `--userid=...` | 사용자 ID |
| `--dist-dir=PATH` | 프로덕션 서빙용 빌드 디렉터리(dev에선 불필요) |

사이드카 전용 env(스튜디오 번들 도구 주입):

| env | 의미 |
| --- | --- |
| `STUDIO_PORT` | 스튜디오 RPC 포트 |
| `STUDIO_HOST` | 스튜디오 RPC 호스트(기본 localhost) |
| `HUB_DOMAIN` | hub 토큰/퍼블리시 계열 |
| `OVERDARE_PROJECT_ID` | 프로젝트 스코프 도구 |

---

## Studio RPC 포트는 어떻게 정해지나

배포된 exe에서는 `--studio-rpc-port`가 **`STUDIO_PORT` 환경변수로 변환**되어 사이드카에 주입된다.

```
exe 인자  --studio-rpc-port=N
  → (apps/overdare-ai-agent/src/webserver.rs)  자식 sidecar에 env STUDIO_PORT=N 주입
  → (apps/overdare-ai-agent/sidecar/src/server.ts)  process.env.STUDIO_PORT 읽음
  → createStudioBundledToolProviders({ studioRpcPort })  → bundledToolProviders 로 주입
  → studiorpc 도구가 TCP로 localhost:STUDIO_PORT 접속
```

런타임 해석 우선순위(`sidecar/src/tools/studiorpc/rpc.ts`):

1. `STUDIO_PORT` / `STUDIO_HOST` 환경변수
2. config 파일 `~/.overdare/overdare.jsonc` (없으면 `~/.diligent/overdare.jsonc`)
   ```jsonc
   { "host": "localhost", "port": 13377 }
   ```
3. 기본값 `localhost:13377`

즉 dev에서는 `STUDIO_PORT` env로 주는 게 exe 동작과 동일하다. 매번 지정하기 귀찮으면 위 config 파일에 한 번 적어두면 된다.

---

## 동작 확인 (스모크 테스트)

부팅 확인:

```bash
lsof -nP -iTCP:7433 -sTCP:LISTEN   # 백엔드
lsof -nP -iTCP:5174 -sTCP:LISTEN   # 프론트
```

백엔드 로그에 다음이 보이면 정상:

```
DILIGENT_PORT=7433
RPC endpoint: ws://localhost:7433/rpc
```

- **웹 UI**: http://localhost:5174 접속 → 빈 화면이 아니라 채팅 UI가 뜨고 우상단 연결 상태가 connected.
- **스튜디오(모드 B)**: 에이전트에게 `studiorpc_level_browse` 같은 작업을 시켜 Studio 응답이 오는지 확인. 연결 실패 시 `STUDIO_PORT`/Studio 리슨 여부부터 점검.

---

## 종료 / 정리

```bash
# 포트로 종료
lsof -ti:7433 | xargs kill
lsof -ti:5174 | xargs kill
```

---

## 트러블슈팅

| 증상 | 원인 / 조치 |
| --- | --- |
| 화면은 뜨는데 RPC 연결 안 됨 | 백엔드(7433)가 안 떠 있음. Vite 프록시 대상은 7433 고정 — 백엔드 포트를 7433으로 맞출 것 |
| `studiorpc_*` 도구가 안 보임 | web 단독 백엔드(`web:dev`)로 띄움. **사이드카 진입점**(`make dev-agent`)으로 다시 띄울 것 |
| studio 연결 타임아웃 | `STUDIO_PORT` 미설정/오설정, 또는 Studio가 해당 포트로 리슨 안 함 |
| 복사 버튼이 localhost에선 잘 되는데 LAN에선 안 됨(과거 버그) | `navigator.clipboard`는 secure context(HTTPS/localhost) 전용 — 비-secure는 fallback 경로 사용 |
| 포트 충돌(`EADDRINUSE`) | 기존 프로세스 종료(위 종료 명령) 후 재실행 |

---

## 참고 (코드 위치)

- web 단독 백엔드 진입점: `packages/web/src/server/index.ts`
- 사이드카 진입점: `apps/overdare-ai-agent/sidecar/src/server.ts`
- 스튜디오 번들 도구: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/`
- exe 인자→env 변환: `apps/overdare-ai-agent/src/webserver.rs`
- Vite 프록시 설정: `packages/web/vite.config.ts`
