# Mac 로컬 Agent ↔ Windows Studio 연결 가이드

Mac에서 agent(사이드카 백엔드 + 프론트)를 띄우고, 별도의 **Windows PC에서 도는 OVERDARE Studio**와 연결해 실행하는 방법을 정리한다. 빌드된 exe나 GitHub release 다운로드 없이, dev 소스를 그대로 띄우는 방식이다.

## 왜 두 머신으로 쪼갤 수 있나

agent ↔ Studio 연결은 **순수 TCP JSON-RPC**다 (`apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`, `net.createConnection`). 둘 사이에 공유 파일시스템이 없고, 모든 Studio 파일 접근은 Windows 쪽 Studio가 RPC로 처리한다. 따라서 agent와 Studio를 서로 다른 머신에 두는 게 구조적으로 자연스럽다.

```
┌─────────────────── Mac ───────────────────┐        ┌──────── Windows PC ────────┐
│  브라우저(5174, Vite)                       │        │                            │
│      │                                     │        │                            │
│      └ /rpc(WS) ─▶ 사이드카 백엔드(7433)     │        │                            │
│                        │                   │        │                            │
│                        └ TCP ──────────────┼────────┼─▶ OVERDARE Studio          │
│                          (STUDIO_HOST:PORT) │  LAN   │   (STUDIO_PORT 리슨)        │
└─────────────────────────────────────────────┘        └────────────────────────────┘
```

### 무엇이 어디에 저장되나

| 항목 | 저장 위치 | 기준 경로 |
| --- | --- | --- |
| skills, knowledge, sessions, images | **Mac** `<--cwd>/.overdare/` | `--cwd` (cwd 상대) |
| 설정(`overdare.jsonc`: host/port), `user-id` | **Mac** `~/.overdare/` | HOME |
| Studio 프로젝트 파일(레벨/콘텐츠 원본) | **Windows** | Studio가 관리 |

> agent의 "두뇌"(스킬·지식·대화기록·설정)는 전부 **Mac**에 있고, 게임 콘텐츠 원본만 **Windows**에 있다. `--cwd`에는 **Mac 경로**를 넣는다(Windows 경로 아님).

---

## 사전 준비

### Mac 쪽

```bash
bun install
```

- AI provider: 앱 UI `Config → AI connection`에서 연결하거나, 자격증명이 keychain/`.env.local`에 있으면 자동 사용.
- 대화 기록은 `--cwd`(기본 `process.cwd()`)의 `<cwd>/.overdare/sessions`에 저장된다.

### Windows 쪽 (이게 실제 관건)

1. **Studio가 LAN 인터페이스(`0.0.0.0` 또는 자기 LAN IP)로 RPC를 리슨해야 한다.** `127.0.0.1`에만 바인딩하면 Mac에서 접속이 안 된다 → 이 경우 [SSH 터널](#studio가-localhost에만-리슨할-때--ssh-터널)로 우회.
2. **방화벽에서 Studio RPC 포트(기본 13377) 인바운드 허용.**
3. Windows의 LAN IP 확인: `ipconfig` → IPv4 주소(예: `192.168.0.42`).

### 도달 확인 (Mac에서)

```bash
nc -vz 192.168.0.42 13377   # Windows IP / Studio 포트
```

연결되면 OK. 안 되면 Windows 리슨 바인딩·방화벽부터 점검.

---

## 방법 1 — env로 직접 실행 (가장 빠름)

매번 환경변수로 Windows의 host/port를 지정한다.

```bash
# 터미널 1 — Mac: 사이드카 백엔드(7433) + Windows Studio 연결
STUDIO_HOST=192.168.0.42 \
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"

# 터미널 2 — Mac: 프론트(Vite, 5174)
bun run --cwd packages/web dev
```

브라우저: **http://localhost:5174**

> ⚠️ 반드시 **사이드카 진입점**(`apps/overdare-ai-agent/sidecar/src/server.ts`)으로 띄워야 `studiorpc_*` 도구가 로드된다. `bun run web:dev`(web 단독, Studio 도구 없음)에는 Studio 도구가 붙지 않는다.

호스트/포트 해석 우선순위 (`rpc.ts:22-40`):

1. `STUDIO_HOST` / `STUDIO_PORT` 환경변수
2. config 파일 `~/.overdare/overdare.jsonc`
3. 기본값 `localhost:13377`

매번 env 지정이 귀찮으면 Mac 홈에 한 번 적어둔다:

```jsonc
// ~/.overdare/overdare.jsonc
{ "host": "192.168.0.42", "port": 13377 }
```

---

## 방법 2 — 번들 스킬 심링크 후 실행 (스킬까지 완비, macOS)

방법 1은 동작하지만, dev에서는 번들 스킬(`actionsequence`, `tpa`, `ui-generator`, `studio-explorer` 등)이 자동으로 깔리지 않는다. exe는 첫 실행 시 `init.rs`가 번들 스킬을 `~/.overdare/skills`로 복사하지만, dev로 직접 띄우면 이 단계를 건너뛰기 때문이다.

스킬 탐색 경로는 ① 프로젝트 `<cwd>/.overdare/skills` → ② 글로벌 `~/.overdare/skills` → ③ config `skills.paths[]` 순이다 (`packages/runtime/src/skills/discovery.ts:47-55`). macOS이므로 **심링크로 글로벌(②)에 번들 스킬을 연결**한다. (심링크라 repo의 스킬을 고치면 즉시 반영된다.)

### 0) 번들 스킬·에이전트 심링크 (한 번만)

```bash
# 저장소 루트에서 실행
mkdir -p ~/.overdare/skills ~/.overdare/agents

ln -sfn "$PWD/apps/overdare-ai-agent/bootstrap/skills/"* ~/.overdare/skills/
ln -sfn "$PWD/apps/overdare-ai-agent/bootstrap/agents/"* ~/.overdare/agents/
```

확인:

```bash
ls -l ~/.overdare/skills/    # actionsequence, tpa, ui-generator ... 가 심링크로 보이면 OK
```

### 1) 사이드카 + 프론트 실행

```bash
# 터미널 1 — Mac: 사이드카 백엔드 + Windows Studio 연결
STUDIO_HOST=192.168.0.42 \
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"

# 터미널 2 — Mac: 프론트(Vite, 5174)
bun run --cwd packages/web dev
```

브라우저: **http://localhost:5174**

> 심링크 해제(원위치): `rm ~/.overdare/skills/*` 는 **심링크만** 지운다(원본 repo 파일은 그대로). 디렉터리 전체를 비우려면 `find ~/.overdare/skills -maxdepth 1 -type l -delete`.

---

## 스크립트로 한 번에 (권장)

위 방법 1·2의 모든 단계(번들 스킬 심링크 → 권한 config 보장 → 7433/5174 정리 → 사이드카+Vite 동시 실행 → Ctrl+C 일괄 종료)를 한 번에 수행하는 런처가 있다.

Studio 접속 정보는 `.env.local` 에 한 번 적어두는 게 기본이다 (bun이 자동 로드하므로 사이드카도, 스크립트도 이 값을 읽는다):

```bash
# .env.local
STUDIO_HOST=10.40.32.103
# STUDIO_PORT=13377   # 기본 13377이면 생략 가능
```

그러면 인자 없이 그대로 실행한다:

```bash
make dev-cross                 # .env.local 의 STUDIO_HOST 사용
# 또는
scripts/dev-cross-studio.sh
```

일회성으로 다른 Studio에 붙고 싶으면 인자/환경변수로 오버라이드한다 (이게 `.env.local`보다 우선):

```bash
make dev-cross STUDIO_HOST=192.168.0.42 STUDIO_PORT=13377
scripts/dev-cross-studio.sh 192.168.0.42 13377
```

> Studio가 **같은 머신**(로컬)에 있으면 `make dev-cross` 대신 **`make dev-agent`** 를 쓴다 — 같은 스크립트지만 `STUDIO_HOST`가 `localhost` 기본이라 인자가 필요 없다. (일반 로컬 개발은 [`local-development.md`](./local-development.md) 참고.)

> `.env.local` 은 `.gitignore` 로 무시된다(API 키 등 비밀값 포함). 커밋 금지.

### 편집까지 하려면 — 월드 디렉터리(마운트 경로) 지정

⚠️ **중요한 한계**: `level.browse` 같은 읽기는 순수 RPC라 위 설정만으로 크로스머신으로 동작하지만, **`instance_upsert`/`instance_read` 등 편집·속성조회 도구는 로컬 `.ovdrjm` 파일을 직접 읽고 쓴다** (그 뒤 `level.apply` RPC로 Studio가 리로드). 따라서 편집을 하려면 agent가 **Studio가 여는 바로 그 라이브 월드 파일**에 파일시스템으로 접근해야 한다.

방법: Windows의 Studio 프로젝트 폴더를 SMB로 공유해 Mac에 마운트한 뒤, 그 경로를 넘긴다.

```bash
# 3번째 인자로 마운트 경로
scripts/dev-cross-studio.sh 10.40.32.103 13377 /Volumes/StudioProject

# 또는 .env.local 에:  STUDIO_PROJECT_DIR=/Volumes/StudioProject
make dev-cross
```

지정 시 사이드카 `--cwd` 가 이 경로가 되어 편집 도구가 라이브 월드를 직접 수정한다. **미지정이면 cwd=repo 가 되어 browse 만 가능하고 편집은 불가**하다.

> 📌 **심링크(스킬)와 마운트(월드 파일)는 별개다.** 헷갈리기 쉬우니 구분:
> - **마운트** = Windows Studio **프로젝트 폴더**를 Mac에서 접근 → 라이브 `.ovdrjm` **월드 파일**을 읽고/쓰기 위함. `--cwd` 가 이 경로.
> - **심링크**(방법 2 / 스크립트) = 번들 **스킬**(actionsequence·tpa·ui-generator 등)을 Mac 글로벌 `~/.overdare/skills` 에 연결. cwd 와 무관(탐색 경로 ②).
>
> 마운트된 프로젝트 폴더에는 번들 스킬이 **없다** — exe 는 스킬을 프로젝트가 아니라 **HOME `~/.overdare/skills`** 에 깐다(`init.rs` → `global_storage_dir`). 그래서 "마운트해서 월드를 편집"해도 **스킬은 여전히 심링크된 Mac 글로벌에서** 와야 한다. 둘 다 필요.

#### SMB 공유 + 마운트 + 쓰기 권한 (편집의 필수 조건)

편집은 곧 마운트된 `.ovdrjm` 에 **쓰는** 동작이다. 마운트가 read-only 면 `EACCES: permission denied ... .ovdrjm` 로 실패한다. 다음을 모두 만족해야 한다.

1. **Windows: 폴더 공유 + 쓰기 권한** — 권한이 두 군데이고 **둘의 교집합(더 엄격한 쪽)** 이 적용되므로 둘 다 열어야 한다.
   - **공유 권한**: 폴더 우클릭 → 속성 → 공유 → 고급 공유 → 권한 → 해당 계정에 **변경(Change)**
   - **NTFS 권한**: 같은 창 → 보안(Security) 탭 → 편집 → 해당 계정에 **수정(Modify)**
   - ⚠️ 권한을 준 Windows 계정이 **Mac에서 마운트할 때 인증하는 계정과 동일**해야 한다.

2. **Mac: 마운트** — Finder `Cmd+K` → `smb://<windows-ip>/<공유이름>` → 등록된 사용자로 로그인(게스트 ❌). `/Volumes/<공유이름>` 에 잡힌다.

3. **권한 변경 후에는 반드시 재마운트** — SMB는 자격증명/권한을 마운트 시점에 캐싱한다. Windows에서 권한을 바꿔도 기존 연결은 옛 권한 그대로다. 캐시까지 비우려면:
   ```bash
   umount /Volumes/<공유이름>
   security delete-internet-password -s <windows-ip>   # Keychain 캐시 제거
   # 그다음 Finder Cmd+K 로 재연결
   ```

4. **쓰기 확인** — 아래가 `✅` 여야 편집이 된다(스크립트도 시작 시 자동 점검한다):
   ```bash
   touch /Volumes/<공유이름>/.__t && echo "✅ 쓰기 OK" && rm /Volumes/<공유이름>/.__t
   ```

> macOS Finder가 표시하는 `-rwx------` 같은 권한 표기는 합성값이라 신뢰할 수 없다. 실제 접근은 Windows ACL이 결정하므로 위 `touch` 테스트로만 판정한다.
>
> 회사 관리(IT 정책) PC라 공유 쓰기를 끝내 못 받으면, 이 방식(Mac agent 편집)은 불가능하다 → 아래 "agent 를 Windows 에서 실행" 대안으로 전환.

> `--cwd` 는 월드 파일 위치이자 `.overdare`(세션·지식·config) 저장 위치를 **동시에** 결정한다. 마운트 경로를 주면 세션 등 런타임 데이터가 그 폴더(=Windows 공유)에 쌓인다(SMB라 느릴 수 있음). 번들 스킬만은 글로벌 `~/.overdare/skills`(Mac) 심링크에서 로드되므로 영향받지 않는다.
>
> 주의: SMB 환경에선 파일 락/지연/개행·인코딩 차이로 편집이 불안정할 수 있다. 안 되면 대안으로 **agent 를 Windows 에서 실행하고 Mac 은 브라우저(`http://<windows-ip>:5174`)로만 접속**하는 구성을 고려한다(파일이 항상 로컬이라 편집이 안정적, 단 코드 HMR 은 소스가 있는 머신에서만 됨).

- 번들 스킬/에이전트 심링크는 **없을 때만** 생성하므로 반복 실행해도 안전하다(idempotent).
- 권한 config(`yolo`)는 글로벌 `~/.overdare/config.jsonc` 에 **없을 때만** 생성한다(이미 있으면 그대로 둠). 글로벌에 두는 이유: cwd가 무엇이든(특히 read-only 마운트여도) 항상 로드되고, 마운트에 쓰기를 시도하지 않아 안전하기 때문.
- 브라우저: **http://localhost:5174**, 종료는 **Ctrl+C** 한 번(백엔드·프론트 같이 내려감).

스크립트 본체: `scripts/dev-cross-studio.sh`. 동작 원리를 이해하려면 아래 수동 단계를 참고.

## 빌드는 필요 없다

- **런타임**: `bun run`이 TypeScript를 네이티브로 직접 실행한다. exe 컴파일도, release 다운로드도 불필요.
- **프론트**: dev에선 Vite가 소스에서 서빙(`bun run --cwd packages/web dev`)하므로 dist 빌드 불필요.
- **번들 스킬**: 빌드가 아니라 "탐색 경로에 올리기"만 하면 된다(방법 2의 심링크).

exe가 하던 일을 dev에선 **`bun run`(런타임) + 심링크 한 번(부트스트랩)** 이 대신한다.

---

## 동작 확인 (스모크 테스트)

부팅 확인 (Mac):

```bash
lsof -nP -iTCP:7433 -sTCP:LISTEN   # 백엔드
lsof -nP -iTCP:5174 -sTCP:LISTEN   # 프론트
```

백엔드 로그에 다음이 보이면 정상:

```
DILIGENT_PORT=7433
RPC endpoint: ws://localhost:7433/rpc
```

- **웹 UI**: http://localhost:5174 → 채팅 UI가 뜨고 우상단 연결 상태 connected.
- **Studio 연동**: agent에게 `studiorpc_level_browse` 같은 작업을 시켜 Windows Studio 응답이 오는지 확인. 실패 시 `STUDIO_HOST`/`STUDIO_PORT`와 Windows 리슨 여부부터 점검.

---

## 트러블슈팅

| 증상 | 원인 / 조치 |
| --- | --- |
| 화면은 뜨는데 RPC 연결 안 됨 | 백엔드(7433)가 안 떠 있음. Vite 프록시 대상은 7433 고정 — 백엔드 포트를 7433으로 맞출 것 |
| `studiorpc_*` 도구가 안 보임 | web 단독 백엔드(`web:dev`)로 띄움. **사이드카 진입점**으로 다시 띄울 것 |
| 번들 스킬(actionsequence 등)이 안 보임 | 방법 2의 심링크 미실행. `~/.overdare/skills`에 심링크 확인 |
| Studio 연결 타임아웃 | `STUDIO_HOST`/`STUDIO_PORT` 오설정, 또는 Windows Studio가 해당 포트로 리슨 안 함 / 방화벽 차단 |
| `nc -vz`는 되는데 RPC만 실패 | Studio가 RPC 프로토콜로 응답 안 함(다른 프로세스가 포트 점유). Studio 재시작 |
| 포트 충돌(`EADDRINUSE`) | 기존 프로세스 종료 후 재실행: `lsof -ti:7433 \| xargs kill` |
| `EACCES: permission denied ... .ovdrjm` / 세션 저장 실패 | 마운트가 read-only. [SMB 쓰기 권한](#smb-공유--마운트--쓰기-권한-편집의-필수-조건) (공유+NTFS) 부여 후 **재마운트**. `browse`는 되는데 편집만 실패하면 거의 이 경우 |
| 권한 고쳤는데도 계속 거부 | SMB 자격증명 캐싱. `umount` + `security delete-internet-password -s <ip>` 후 재연결. Finder 표기 권한 말고 `touch` 테스트로 판정 |

### Studio가 localhost에만 리슨할 때 — SSH 터널

Windows Studio가 `127.0.0.1`에만 바인딩해 LAN 접속이 막히면, Mac에서 SSH 터널로 우회한다:

```bash
# Mac: Windows의 13377을 Mac의 13377로 포워딩
ssh -L 13377:localhost:13377 <windows-user>@192.168.0.42
```

터널을 띄운 채로 사이드카는 **localhost**를 보게 한다:

```bash
STUDIO_HOST=localhost STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"
```

---

## 대안 — agent 를 Windows 에서 실행 (SMB 쓰기를 못 받을 때)

회사 정책 등으로 공유 쓰기 권한을 끝내 못 받으면, Mac에서 월드를 편집하는 건 불가능하다. 이때는 **agent 를 Windows(= Studio 옆)에서 돌린다.** 월드 파일이 로컬이라 권한 문제가 사라지고, 프로덕션 exe 구조와도 일치한다. 이건 사실 `local-development.md` 의 **모드 B(같은 머신 사이드카)** 를 Windows에서 하는 것이다.

```bash
# Windows (Git Bash / PowerShell), repo + bun 설치 후:
bun install

# Studio가 로컬이라 STUDIO_HOST 불필요(기본 localhost)
STUDIO_PORT=13377 bun run apps/overdare-ai-agent/sidecar/src/server.ts \
  --dev --port=7433 --cwd="C:/path/to/StudioProject"   # 실제 .umap 있는 폴더(로컬 경로)

bun run --cwd packages/web dev
```

- `--cwd` 는 이제 **Windows 로컬 경로**(`C:/...`)다. 로컬이라 읽기/쓰기 모두 됨.
- Mac에서 보려면 브라우저로 `http://<windows-ip>:5174` 접속(프론트는 얇은 WS 클라이언트). Studio 3D 결과는 Windows 화면(또는 원격데스크톱)에서 본다.

### Mac에서 코드 짜며 HMR 유지하기

HMR은 소스가 있는 머신(이 경우 Windows)에서 돌아야 한다. Mac에서 개발하려면 **Windows 파일을 Mac에서 원격 편집**한다:

- **VS Code / Cursor Remote-SSH** (권장): Mac UI로 Windows 파일을 직접 편집 → 저장 시 Windows 로컬 파일이 바뀌어 Vite/사이드카가 HMR로 즉시 반영. 포트 포워딩으로 `http://localhost:5174` 를 Mac에서 봄.
- **파일 동기화**(Mutagen/Syncthing): Remote-SSH가 안 되는 환경의 대안. Mac↔Windows repo 양방향 sync.

---

## 종료 / 정리

```bash
lsof -ti:7433 | xargs kill   # 백엔드
lsof -ti:5174 | xargs kill   # 프론트
```

---

## 참고 (코드 위치)

- 사이드카 진입점: `apps/overdare-ai-agent/sidecar/src/server.ts`
- Studio RPC(연결·host/port 해석): `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`, `config.ts`
- 번들 스킬·에이전트 원본: `apps/overdare-ai-agent/bootstrap/skills/`, `bootstrap/agents/`
- 스킬/에이전트 탐색 경로: `packages/runtime/src/skills/discovery.ts`, `agents/discovery.ts`
- exe 인자→env 변환(`--studio-rpc-port` → `STUDIO_PORT`): `apps/overdare-ai-agent/src/webserver.rs`
- exe 부트스트랩 복사(번들→글로벌): `apps/overdare-ai-agent/src/init.rs`
- 런타임 번들 다운로드: `apps/overdare-ai-agent/src/update.rs`
- Vite 프록시 설정: `packages/web/vite.config.ts`

> 같은 머신(Mac)에 Studio까지 두는 일반 로컬 개발은 [`local-development.md`](./local-development.md) 참고.
