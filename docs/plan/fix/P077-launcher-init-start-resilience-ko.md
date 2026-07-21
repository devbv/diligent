---
id: P077
status: in-progress # 런처 쪽 Phase 1–3 구현 완료 (2026-07-15). 잔여: Studio 쪽 라인 파싱/UI 소비, Confluence 문서 갱신 (§7)
created: 2026-07-15
---

# Agent 런처 init/start 실패 처리·리트라이·리커버리 강화 (한글)

## 목표

OVERDARE Studio 데스크탑 앱이 호출하는 Rust 런처(`apps/overdare-ai-agent`)의
`init` / `start` 경로에서, 일시적 실패(네트워크 플레이크, AV 락, 느린 부팅)가
Studio의 에이전트 실행 자체를 막지 않도록 리트라이와 리커버리(폴백) 로직을
보강한다. 원칙은 두 가지:

1. **일시적 실패는 런처가 흡수한다** — 재시도로 해결되는 실패를 Studio까지
   전파하지 않는다.
2. **이미 부팅 가능한 상태를 절대 깨지 않는다** — 업데이트/체크 실패가
   기존에 설치된 런타임의 실행을 막으면 안 된다.

> 참고 문서: Confluence [MCP AI Agent Web Server 초기화 설계](https://overdare.atlassian.net/wiki/spaces/NFTMetaverse/pages/394002463),
> [MCP Service 시스템 구현](https://overdare.atlassian.net/wiki/spaces/NFTMetaverse/pages/236879957).
> 두 문서 확인 완료 — Studio 쪽 호출 시퀀스는 §1.1에, 그로 인한 제약은 §4/§7에 반영했다.

## 1. 현재 구조 요약

Studio 데스크탑 앱 → 런처 CLI 호출 흐름:

```
overdare-ai-agent init            # 런타임 다운로드/업데이트 보장
overdare-ai-agent start --cwd=... --studio-rpc-port=...
  → stdout으로 WEBSERVER_PORT=<port> 출력, Studio가 이를 파싱해 접속
```

### 1.1 Studio(에디터) 쪽 런처 생명주기 — Confluence 문서 확인 결과

`MCPAgentWebServer.cpp` / `MCP.cpp` (에디터 쪽 구현, 문서 기준):

- **init은 에디터 세션당 1회**, 에디터 기동 시(`Initialize()`) 실행. 워커 스레드
  (`InitMonitorThread`)가 0.2초 주기로 파이프 드레인 + 종료 감지.
- **init 타임아웃 60초** (`INIT_MONITOR_TIMEOUT = 60.0f`). 타임아웃되거나
  `InitReturnCode != 0`이면 `bInitCompleted == false`가 되어 **그 에디터 세션
  내내 start가 차단**된다. 세션 내 init 재시도 경로는 없다(문서의 알려진 한계 #1).
- **start는 프로젝트/맵 오픈 시** 실행. init 진행 중이면 티커로 지연했다가
  완료 후 실행. Studio는 init의 **exit code 0/비0만 판정**하고, start 프로세스는
  Job Object(`KILL_ON_JOB_CLOSE`)로 에디터 종료 시 함께 정리된다.
- start 프로세스 크래시 후 자동 재시작은 Studio 쪽에도 없다 (§4 비변경 결정의 전제 확인됨).

> 이 중 "런처 관점" 핵심 제약 두 가지:
> **(A) init은 실질적으로 60초 예산 안에 끝나야 한다** — 그 이상 걸리면 성공해도
> Studio가 이미 타임아웃 처리했다.
> **(B) init이 비0으로 종료하면 그 세션의 에이전트 기능 전체가 죽는다** — 폴백
> 성공(P1)을 exit 0으로 처리하는 것이 단순 UX 개선이 아니라 세션 생존 문제다.

### init 경로 (`cli.rs::run_init` → `update.rs::run_with_progress` → `init.rs::run`)

1. 네임스페이스 마이그레이션 → env/pin 출력
2. `init_status()`: 매니페스트 fetch로 latest 버전 확인
3. `run_with_progress()`: flat 런타임 마이그레이션 → stale scratch 청소 →
   매니페스트 fetch(재확인) → 번들 다운로드 → SHA256 검증 → 압축 해제 →
   레이아웃 검증 → `runtime-v<ver>` 승격 + 포인터 원자적 전환 → 구버전 정리
4. `init::run()`: bootstrap 에셋 배포 (best-effort)

### start 경로 (`cli.rs::run_webserver` → `webserver.rs::start_foreground`)

1. 마이그레이션 → `resolve_runtime_dir()` (핀 버전 또는 포인터, 없으면 legacy 폴백)
2. 사이드카(`diligent-web-server`) spawn (`--parent-pid` 전달 → 사이드카가 부모 사망 감지 시 자체 종료)
3. stdout에서 `WEBSERVER_PORT=` 라인 대기 (**15초 타임아웃**)
4. `/health` 폴링 (**30초 데드라인**, 요청당 2초, 200ms 간격)
5. `WEBSERVER_PORT=<port>` 출력 후 자식 프로세스 종료 대기

### 이미 갖춰진 안정성 장치 (재발명 금지)

| 장치 | 위치 |
|---|---|
| 매니페스트 fetch 리트라이 3회 + 지수 백오프 + retryable 분류(5xx / dev-latest 404 / 네트워크·body 에러) | `update.rs::fetch_manifest` |
| Windows 파일락 리트라이 8회×350ms | `update.rs::retry_fs_op` |
| pid 격리 staging/zip + 원자적 포인터 전환 + 동시 설치 수렴(converge) | `update.rs::finalize_runtime_install` |
| 실패 설치 scratch 즉시 폐기 + 24h 경과 orphan sweep | `discard_transient_install`, `sweep_stale_scratch` |
| 디스크 재사용(동일 버전 재설치 시 다운로드 생략) | `UpdateOutcome::ReuseInstalled` |
| SHA256 사전 검증(디스크 기록 전) | `run_with_progress` |
| 손상 포인터 → legacy flat 런타임 폴백 | `current_runtime_dir` |
| `--skip-update` 오프라인 경로(네트워크 미접촉) | `cli.rs::run_init` |

실패 잔여물 정리는 이미 전 구간이 커버된다: 다운로드는 SHA 검증 전까지
메모리에만 존재하므로 중단돼도 디스크 잔여물이 없고, 설치 중 에러는
`discard_transient_install`이 즉시 정리하며, 강제 종료(Studio의 60초 kill 포함)로
남은 zip/staging은 pid 격리 이름이라 다음 실행과 충돌하지 않고 24h 경과 후
sweep이 회수한다. 깨진 `runtime-v*` 잔해는 `is_complete_install`이 완전 설치와
구분해 치운다. 즉 "잔여 파일 때문에 다음 init/start가 실패"하는 경로는 없다.

## 2. 격차 분석 (init)

### G1. 업데이트 체크/다운로드 실패 = init 전체 실패 (기존 런타임이 있어도)

`run_init`은 `init_status()`의 매니페스트 fetch가 (리트라이 소진 후) 실패하면
그대로 에러를 반환한다. **이미 부팅 가능한 런타임이 설치돼 있어도** 네트워크
플레이크 하나로 init이 실패하고, Studio 관점에서는 에이전트 실행 자체가 막힌다.
가장 큰 리커버리 격차.

### G2. 번들 다운로드에 리트라이가 없고 타임아웃이 부적절

`fetch_update`의 번들 다운로드는 단일 시도이며, `Client::timeout(30s)`는
**전체 요청 시간**(body 수신 포함) 기준이다. 런타임 번들은 수백 MB급이라
느린 회선에서는 정상 다운로드도 30초를 초과해 실패한다. 매니페스트 fetch에는
있는 리트라이·백오프·retryable 분류가 다운로드에는 없다.

### G3. 압축 해제 실패에 리트라이 없음

`extract_zip`은 Windows에서 `Expand-Archive`를 사용한다. AV 실시간 검사가
zip 또는 추출 파일을 잠시 잡으면 일시적으로 실패할 수 있는데, 단일 시도라
그대로 init 실패가 된다. zip은 SHA 검증을 통과해 디스크에 있으므로 재시도
비용이 낮다.

### G4. Studio가 실패 종류를 구분할 수 없음

모든 실패가 exit code `1` + 자유 형식 stderr 텍스트다. Studio는
"네트워크 문제(재시도 가치 있음)" vs "설치 손상(init 재실행 필요)" vs
"설정 오류(사용자 개입 필요)"를 구분할 수 없어 일괄 실패 UI만 띄울 수 있다.

## 3. 격차 분석 (start)

### G5. 포트/헬스 대기 실패 시 자식 프로세스를 명시적으로 정리하지 않음

`start_foreground`에서 포트 라인 타임아웃(15s) 또는 헬스체크 실패(30s) 시
에러를 반환하며 `tokio::process::Child`가 drop되는데, `kill_on_drop`이 설정돼
있지 않아 사이드카는 계속 살아 있다. CLI 프로세스 종료 후 사이드카의
`--parent-pid` 감시로 결국 정리되긴 하지만, (a) 라이브러리처럼 재사용될 경우
누수이고, (b) **재시도를 구현하려면 이전 자식을 먼저 죽여야**(특히
`--web-server-port` 고정 포트에서 충돌) 하므로 명시적 kill이 선행 조건이다.

### G6. start 실패에 재시도 없음

spawn 실패, 포트 라인 타임아웃, 헬스체크 타임아웃 모두 1회 실패 즉시 종료.
첫 부팅 시 Windows Defender의 신규 바이너리 검사 등으로 부팅이 일시적으로
느려지는 케이스가 재시도 한 번으로 흡수 가능하다.

### G7. 헬스 데드라인이 고정 30초

느린 디스크/AV 검사 환경에서 첫 부팅이 30초를 넘으면 구제 수단이 없다
(재빌드 없이 조정 불가).

### G8. 런타임 부재 시 start가 수동 리커버리를 요구

포인터 손상 + legacy 부재(또는 사용자가 `~/.overdare` 삭제) 시 start는
"run init first" 에러만 낸다. Studio가 이 문자열을 파싱해 init을 다시 돌리지
않는 한 사용자는 막힌다.

## 4. 제안 변경 사항

### P1. init: 업데이트 실패 시 기존 런타임으로 폴백 (G1) — 최우선

폴백의 동작 원리: Studio는 init이 exit 0일 때만 start를 호출하므로, "init은
실패했지만 start는 실행"이 아니라 **업데이트 단계 실패를 init 전체 실패로
승격하지 않고 init을 exit 0으로 끝내는 것**이다. 이후 start(핀 없음)는 설치된
버전들을 탐색·비교하지 않고 포인터 파일(`runtime-current.json`)이 가리키는
단일 활성 버전을 실행하는데, 포인터는 설치 성공 시에만 갱신되므로 업데이트가
실패한 세션에서는 자연히 직전 정상 버전이 뜬다.

`run_init`에서 매니페스트 fetch / 다운로드 / 설치가 실패했을 때:

- `runtime_installed(env) == true`(부팅 가능한 런타임 존재)이면:
  경고를 stderr에 남기고 **exit 0으로 성공 처리**, 기존 런타임 유지.
  `init::run(env, false)`(bootstrap 배포)는 그대로 수행.
  - "부팅 가능" 판정 = start의 `resolve_runtime_dir`가 launch 전에 쓰는 것과
    **동일한 술어**(`runtime_layout_exists`: 사이드카 바이너리 + `dist/client`
    존재). 따라서 init이 폴백을 선언한 디렉토리와 start가 실제 띄우는
    디렉토리는 항상 일치한다. 파일 존재 검사이므로 설치 후 외부 훼손으로
    내용이 깨진 극단 케이스는 통과하는데, 그건 start 단계 실패 보고(P5/P4)가
    받아낸다.
  - 관측성: 폴백 경고에는 현재 버전·latest 버전·실패 사유를 함께 남긴다.
    Studio의 init 모니터가 stdout/stderr 파이프를 캡처해 에디터 로그로
    남기므로(§1.1) 로그 노출은 추가 작업 없이 이뤄지고, 사용자 대상 UI
    알림은 P4의 `INIT_RESULT=fallback` 라인을 Studio가 소비하는 방식으로
    한다(로그 문자열 파싱 금지).
- 런타임이 없으면(최초 부트스트랩): 지금처럼 실패. 폴백 대상이 없다.
- 구조화 출력(P4)에 `INIT_RESULT=fallback` + 실패 사유를 실어 Studio가
  "구버전으로 실행 중" 안내를 띄울 수 있게 한다.
- **§1.1-(B)에 의해 최우선 확정**: 현재는 업데이트 체크 실패(비0 exit) 하나로
  그 에디터 세션의 에이전트 기능 전체가 차단된다. 폴백 exit 0이 이를 직접 해소한다.

주의: `updateMode: disabled` 경로와 pinned(`@<version>`) init은 의미가 다르다.
핀 버전이 미설치인데 다운로드가 실패하면 폴백하지 않고 실패해야 한다
(핀은 "정확히 그 버전" 계약 — `resolve_runtime_dir`의 no-fallback 원칙과 동일).

정책 근거: init의 계약은 "latest 보장"이 아니라 "실행 가능한 런타임 보장,
가능하면 latest"다. `--skip-update`와 `updateMode: disabled`가 이미 "구버전으로
exit 0"을 정상 상태로 인정하고 있고, P1은 이를 일시적 네트워크 실패까지
확장할 뿐이다. 강제 업데이트가 필요한 릴리스(프로토콜 비호환 등)가 생기면
매니페스트에 `minVersion` 필드를 추가해 "설치본 < minVersion이면 폴백 거부"로
확장한다 — 지금은 그런 릴리스가 없으므로 구현하지 않는다.

### P2. init: 번들 다운로드 리트라이 + 타임아웃 재설계 (G2)

- `fetch_manifest`와 동일한 정책 재사용: 3회 시도, 지수 백오프(500ms 기준),
  retryable 분류(네트워크 에러 / 5xx / body 읽기 에러는 재시도, 그 외 4xx는 종결).
- 다운로드용 클라이언트는 `connect_timeout(10s)` + 전체 타임아웃 완화. 30초
  전체 타임아웃은 정상 다운로드를 실패시키는 원인이므로 제거.
  (스트리밍 + 무진행 감지는 과설계 — 전체 상한으로 충분.)
- SHA256 검증 실패도 "손상 다운로드"로 보고 1회 재다운로드 대상에 포함
  (CDN 스왑 중 잘린 body가 그대로 내려온 케이스).
- **§1.1-(A) 60초 예산 제약**: Studio가 init을 60초에 타임아웃시키므로, 런처가
  내부에서 수 분짜리 리트라이를 도는 것은 무의미하다(성공해도 세션은 이미 차단).
  따라서:
  - **기존 런타임이 있는 init**(일반 케이스): 다운로드+리트라이 총예산을
    **기본 45초**로 잡고, 초과 시 P1 폴백으로 즉시 전환한다. 예산은 반드시
    Studio 타임아웃보다 짧아야 한다 — 같으면(60초=60초) 예산 소진 후 폴백
    처리가 끝나기 전에 Studio 쪽 시계가 먼저 발화해 exit 0이 무의미해진다.
    값은 `DILIGENT_INIT_NETWORK_BUDGET_SECS`(기본 45)로 빼두어 Studio가
    타임아웃을 올리면 재빌드 없이 따라간다. 다음 에디터 기동 시 init이 다시
    시도하므로 업데이트는 결국 따라잡는다.
  - **최초 부트스트랩**(런타임 없음): 폴백 대상이 없고, 수백 MB 다운로드는
    회선에 따라 60초를 정상적으로 초과한다. 이는 런처만으로 해결 불가 —
    Studio의 60초 고정 타임아웃을 늘리거나, 런처의 진행 출력(이미
    `downloading v…` 등을 stdout에 출력 중)을 Studio 모니터가 "진행 중"
    신호로 해석해 타임아웃을 연장하는 협의가 필요하다 (§7-1).

### P3. init: 압축 해제 1회 재시도 (G3)

`extract_zip` 실패 시 짧은 대기(1~2초) 후 1회 재시도. staging은
`extract_zip`이 이미 초기화하므로 재시도는 안전(idempotent). 2회 실패면 종결.

### P4. init/start: 구조화된 결과 출력 + exit code 체계 (G4)

Studio가 이미 `WEBSERVER_PORT=` 라인을 파싱하는 프로토콜을 그대로 확장:

- 프로세스 종료 직전, stdout 마지막에 기계가 읽을 결과 라인:
  - `INIT_RESULT=updated|up-to-date|fallback|skipped`
  - fallback일 때는 `FALLBACK_REASON=<code>` 라인을 함께 출력 (성공이지만
    업데이트 단계가 왜 실패했는지 전달)
  - 실패(exit 비0) 시에는 stderr 마지막에 `ERROR_CODE=<code>` 라인
  - `ERROR_CODE`와 `FALLBACK_REASON`은 **동일한 사유 코드 테이블**을 공유한다.
    키 이름이 성공/실패를 구분하므로 "`ERROR_CODE` 존재 ⇔ exit 비0" 불변식이
    유지되어 Studio 쪽 파싱이 단순해진다.
- 사유 코드 테이블 (분류 기준은 "받는 쪽이 무엇을 하면 되는가" — 세부 사유는
  코드가 아니라 사람 대상 로그 메시지에 남긴다. 값은 §7-3에서 확정):

  | 코드 | 이름 | 실패 지점 | 재시도 가치 |
  |---|---|---|---|
  | `10` | `network` | 매니페스트 fetch/번들 다운로드의 네트워크 에러·타임아웃·5xx·404 리트라이 소진, 45초 예산 초과 포함 | 있음 (다음 기동 시 자연 해소 가능) |
  | `20` | `disk` | zip 쓰기·압축 해제·rename·포인터 쓰기 등 FS 실패 (AV 락 리트라이 소진 포함) | 있음 (공간/AV 확인) |
  | `21` | `verify` | SHA256 불일치가 재다운로드 후에도 지속 | 없음 (릴리스 손상) |
  | `30` | `manifest` | 매니페스트 파싱 실패·env 불일치·핀 버전 불일치·플랫폼 번들 없음 | 없음 (릴리스/설정 문제) |

  같은 코드라도 채널로 상황이 갈린다: exit 0 + `FALLBACK_REASON=10`은
  "구버전으로 실행 중(네트워크)", exit 비0 + `ERROR_CODE=10`은 "최초 설치
  실패(폴백 대상 없음)". 45초 예산 초과는 본질이 느린 네트워크라 `10`에
  포함하고, 구분이 필요해지면 그때 세분한다.
- 전달 경로는 신규 인프라가 필요 없다: Studio의 init 모니터(`PollInit`)가
  이미 stdout/stderr 파이프를 폴링마다 드레인해 캡처한다(§1.1). 라인을
  파싱해 UI에 반영하는 부분만 Studio 쪽 신규 작업이다.
- exit code 구분 (예시):
  - `0` 성공(폴백 포함) / `10` 네트워크(재시도 가치) / `20` 설치·디스크 손상
    (init 재실행 필요) / `30` 설정·인자 오류(사용자 개입) / `40` start 부팅 실패
- 기존 사람 대상 메시지는 유지 — 라인 추가만 하므로 하위 호환.
- Studio는 현재 init의 **exit code 0/비0만 판정**하므로(§1.1) 세분화된 코드는
  순수 additive다 — Studio가 소비를 시작하기 전에도 배포에 안전하다. init은
  stdout/stderr 파이프를 Studio가 캡처·로깅하므로 라인 프로토콜이 그대로 전달된다.
- **Studio 팀과 코드 체계 합의 필요** (§7). Confluence 문서 갱신도 이 단계에서.

### P5. start: 실패 시 자식 kill + 1회 재spawn (G5, G6)

- `cmd.kill_on_drop(true)` 설정 + 포트/헬스 대기 실패 경로에서 명시적
  `child.kill().await` (에러는 무시 — best-effort).
- spawn → 포트 대기 → 헬스체크 전체를 한 attempt로 묶어 **총 2회 시도**
  (재시도 전 2초 대기). 이전 자식을 확실히 죽인 뒤 재spawn하므로 고정 포트
  (`--web-server-port`)에서도 안전.
- 사이드카가 포트 출력 전에 스스로 종료한 경우(현재 exit code + 로그 경로를
  잘 보여주는 경로)는 **재시도하지 않는다** — 크래시는 재spawn해도 같은 결과일
  가능성이 높고, 진단 메시지를 빨리 보여주는 편이 낫다. 타임아웃 계열만 재시도.

### P6. start: 헬스 데드라인 환경변수화 (G7)

`DILIGENT_START_HEALTH_TIMEOUT_SECS`(기본 30) 하나만 추가. 포트 라인
타임아웃(15s)도 같은 방식(`DILIGENT_START_PORT_TIMEOUT_SECS`)으로. 플래그가
아닌 env로 두어 Studio 호출 시그니처를 건드리지 않는다.

### P7. start: `--init-if-missing` 옵션 (G8)

`start --init-if-missing`: `resolve_runtime_dir`가 "런타임 없음"으로 실패하면
내부적으로 init(업데이트 포함)을 1회 수행 후 start를 재개한다.

- 핀 버전 start에도 동일 적용(핀 버전 init 후 start).
- 기본 동작은 현행 유지(플래그 없으면 지금처럼 실패) — Studio가 옵트인.
- 이 플래그가 있으면 Studio는 init/start 2단계 호출을 start 1회로 줄이는
  선택지도 생긴다(문서 확인 후 결정).

### 비변경 (의도적 제외)

- **start 이후 사이드카 크래시 자동 재시작(restart policy)**: 실행 중 세션
  상태는 런처가 복구할 수 없고, 재시작 판단(UI 알림, 재접속)은 Studio의
  책임이 자연스럽다. 런처는 P4의 exit code로 "비정상 종료"만 명확히 알린다.
  (문서 확인: Studio 쪽에도 재시작 로직은 없으며 Job Object로 에디터 종료 시
  정리만 보장 — 크래시 후 재시작 UX는 Studio 쪽 과제로 §7에 기재.)
- **다운로드 이어받기(HTTP Range)**: 전체 재다운로드 리트라이로 충분. 번들
  크기가 GB급으로 커지면 그때 도입.
- **고정 포트 충돌 시 랜덤 포트 폴백**: 포트를 고정한 호출자는 그 포트를
  기대한다. 다른 포트로 몰래 뜨는 것보다 명확한 실패가 낫다.

## 5. 구현 단계

### Phase 1 — 리커버리 핵심 (가장 높은 사용자 영향)

1. P1: init 업데이트 실패 → 기존 런타임 폴백 (`cli.rs::run_init`)
2. P5 전반부: `kill_on_drop` + 실패 경로 명시적 kill (`webserver.rs`)
3. P2: 다운로드 리트라이 + 타임아웃 재설계 (`update.rs::fetch_update`)

### Phase 2 — 리트라이 보강

4. P5 후반부: start 타임아웃 계열 1회 재시도 (`webserver.rs::start_foreground` 호출부)
5. P3: extract 1회 재시도 (`update.rs::extract_zip` 호출부)
6. P6: 타임아웃 env 설정화

### Phase 3 — Studio 연동 프로토콜

7. P4: `INIT_RESULT=` / `ERROR_CODE=` / exit code 체계 — **런처 쪽 구현 완료**
   (additive라 Studio 소비 전에 배포해도 안전; 코드 값 확정은 §7-3)
8. P7: `start --init-if-missing` — **구현 완료** (옵트인, Studio가 쓰기 전까지 무영향)
9. Confluence 두 문서(런처 실행 가이드, MCP Service) 갱신 + Studio 쪽 라인
   파싱/UI 소비 — **잔여 작업**

## 6. 테스트 계획

- **유닛**: 폴백 판정(런타임 유무 × 실패 종류 × pin 유무 매트릭스),
  다운로드 retryable 분류(기존 `is_retryable_manifest_status` 테스트 패턴 재사용),
  exit code 매핑. 기존 `with_temp_home` 테스트 유틸 활용.
- **수동 시나리오** (Windows 우선 — Studio 타깃 플랫폼):
  1. 설치 완료 상태에서 네트워크 차단 → `init` exit 0 + `INIT_RESULT=fallback`
  2. 최초 설치(런타임 없음) + 네트워크 차단 → `init` 실패 (exit 10)
  3. 다운로드 중 프록시로 5xx 1회 주입 → 재시도로 성공
  4. `--web-server-port` 고정 + 첫 attempt 헬스 타임아웃 유도 → 이전 자식 종료
     확인 후 재시도 성공, 포트 충돌 없음
  5. `~/.overdare/updates` 삭제 후 `start --init-if-missing` → 자동 복구
  6. start 실패 직후 `tasklist`로 orphan `diligent-web-server.exe` 부재 확인

## 7. Studio 팀 협의 항목 (문서 확인 후 잔여)

Confluence 문서 2건 확인으로 호출 시퀀스(§1.1)·exit code 소비 방식(0/비0만)·
크래시 재시작 부재는 해소됐다. 남은 협의 항목:

1. **init 60초 타임아웃과 최초 부트스트랩의 충돌** (P2 참조): 첫 설치의 수백 MB
   다운로드는 60초를 정상적으로 초과할 수 있다. 선택지 — (a) Studio의
   `INIT_MONITOR_TIMEOUT` 상향, (b) 런처의 진행 라인(`downloading v…` 등) 출력을
   "진행 중" 신호로 삼아 타임아웃을 진행 기반으로 연장, (c) 부트스트랩만 별도
   타임아웃. 런처 쪽 P4 라인 프로토콜이 (b)의 기반이 된다.
2. **init 타임아웃/실패 시 세션 전체 차단 정책** (Studio 문서의 알려진 한계 #1):
   P1 폴백이 들어가면 "런타임이 하나도 없는 최초 실패"만 남는다. 이 케이스에
   세션 내 init 재시도 UX(수동 재시도 버튼 등)를 Studio에 둘지 협의.
3. P4 `ERROR_CODE=`/exit code 체계의 값 확정 및 Studio 소비 시점.
4. `dev-latest` 릴리스 스왑 윈도우 동안 Studio 쪽에 별도 재시도가 있는가?
   (있다면 런처 리트라이 횟수와 곱해지지 않게 조정 — 문서에는 언급 없음)
