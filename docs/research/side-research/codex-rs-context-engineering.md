# Codex-rs Context Engineering Research

> Codex-rs의 메모리 시스템, 컴팩션, 컨텍스트 엔지니어링에 대한 분석.
> 긴 대화에서도 맥락을 잘 유지하는 방법에 초점.

## Overview: 3-Layer Context Architecture

Codex는 긴 대화에서 맥락을 유지하기 위해 3개의 계층으로 구성된 아키텍처를 사용한다:

1. **Compaction** — 대화 내(intra-conversation) 압축: 컨텍스트 윈도우가 가득 차면 대화를 요약
2. **Memory System** — 대화 간(inter-conversation) 지식 유지: 2-phase 비동기 파이프라인으로 장기 기억 추출/통합
3. **Context Manager** — 턴 단위 최적화: truncation, diffing, normalization으로 토큰 효율 극대화

이 3개 계층은 독립적이면서도 상호 보완적으로 동작한다. 특히 **Compaction과 Memory는 완전히 별개의 시스템**이지만, Compaction으로 인한 정보 손실을 Memory가 부분적으로 보상하는 구조로 설계되어 있다.

---

## 1. Compaction (대화 내 압축)

### 핵심 파일
- `core/src/compact.rs` — 컴팩션 메인 로직 (local compaction)
- `core/src/compact_remote.rs` — OpenAI provider용 원격 컴팩션 (remote compaction)
- `core/templates/compact/prompt.md` — 컴팩션 프롬프트 (local에서만 사용)
- `core/templates/compact/summary_prefix.md` — 요약 프리픽스 (local에서만 사용)

### Local vs Remote Compaction

Codex는 다중 provider를 지원한다 (빌트인: `openai`, `ollama`, `lmstudio` + config.toml 커스텀).
Provider에 따라 컴팩션 경로가 분기된다:

```rust
// compact.rs:50-52
pub(crate) fn should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool {
    provider.is_openai()
}
```

| | Local Compaction (`compact.rs`) | Remote Compaction (`compact_remote.rs`) |
|---|---|---|
| **대상 provider** | OpenAI 외 (ollama, lmstudio, 커스텀) | OpenAI만 |
| **요약 생성 주체** | 클라이언트가 모델에 프롬프트를 보내 요약 생성 | 서버 API (`POST responses/compact`)가 압축된 히스토리 반환 |
| **프롬프트** | `prompt.md` + `summary_prefix.md` 사용 | 사용 안 함 (서버가 자체 로직으로 처리) |
| **히스토리 재구성** | 클라이언트: `[initial context] + [최근 user msgs 원문] + [요약]` | 서버가 반환한 히스토리를 `should_keep_compacted_history_item()`으로 필터링 후 사용 |
| **CWE 에러 복구** | 가장 오래된 히스토리 아이템 제거 후 재시도 | 없음 (서버 측 처리) |

공통 메커니즘 (양쪽 동일):
- model switch 추출 → 컴팩션 후 재부착
- ghost snapshot 보존
- `InitialContextInjection` 기반 initial context 재주입
- rollout 기록 (`persist_rollout_items`)

### 두 가지 컴팩션 모드

#### Mid-turn Compact (턴 중간, tool call 루프 도중 자동 발동)
- `InitialContextInjection::BeforeLastUserMessage` 사용
- **핵심**: 모델이 학습 시 기대하는 분포를 유지하기 위해, initial context를 마지막 user message 직전에 재주입
- 컴팩션 후에도 `reference_context_item`을 유지하여 다음 턴에서 diff 기반 업데이트 가능

#### Pre-turn / Explicit Compact (턴 시작 전 또는 사용자 직접 요청)
- `InitialContextInjection::DoNotInject` 사용
- 히스토리를 완전히 교체하고 `reference_context_item`을 None으로 초기화
- 다음 턴에서 시스템 프롬프트 전체를 새로 주입
- **참고**: Pre-turn compact와 Explicit compact 모두 `DoNotInject`를 사용. 구분은 "mid-turn vs. 나머지 전부"

### 컴팩션 트리거 조건

3가지 경로로 컴팩션이 발동된다:

```
1. Pre-turn compact (턴 시작 전)
   ├─ 모델 전환 시: 큰 윈도우 → 작은 윈도우로 갈 때, 이전(큰) 모델로 먼저 compact
   └─ 토큰 한도 도달 시: total_usage_tokens >= auto_compact_token_limit

2. Mid-turn compact (tool call 루프 도중)
   └─ 샘플링 후 토큰 한도 초과 + needs_follow_up인 경우

3. Explicit compact (사용자/API 직접 트리거)
   └─ CompactTask를 통해 UI/API에서 직접 요청
```

**참고**: `ContextWindowExceeded` API 에러는 별도의 컴팩션 트리거가 아니라,
컴팩션 **프로세스 내부**의 에러 복구 메커니즘이다 (`compact.rs:194-204`).
컴팩션 요약을 생성하는 도중 윈도우를 초과하면 가장 오래된 히스토리 아이템을 제거하고 재시도한다.

### 컴팩션 프로세스 (`run_compact_task_inner`)

```
1. 히스토리 클론
2. model_switch developer message 추출 (컴팩션 대상에서 제외)
3. 유저 입력을 히스토리에 추가
4. 모델로 스트리밍 요약 생성 (retry + exponential backoff)
   - ContextWindowExceeded 시: 가장 오래된 히스토리 아이템 제거 후 재시도
5. 요약 텍스트 추출
6. 최근 user messages 중 토큰 예산(20,000) 내에서 역순으로 선별
7. [initial_context] + [선별된 user messages] + [요약] 으로 새 히스토리 구성
8. model_switch item 재부착
9. ghost snapshots 복원
10. 히스토리 교체 + 토큰 사용량 재계산
```

### 컴팩션 프롬프트

```markdown
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary
for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
```

### Summary Prefix (다른 LLM에게 넘기는 프레임)

```markdown
Another language model started to solve this problem and produced a summary
of its thinking process. You also have access to the state of the tools that
were used by that language model. Use this to build on the work that has
already been done and avoid duplicating work.
```

**핵심 인사이트**: 컴팩션을 "다른 LLM에게의 핸드오프"로 프레이밍하여, 모델이 이전 맥락을 자연스럽게 이어받도록 유도한다.

### 컴팩션 후 정확도 유지 방어 메커니즘

Codex 스스로 정확도 손실을 인정하고 경고를 띄운다:

```rust
// compact.rs:274-276
"Heads up: Long threads and multiple compactions can cause the model to be
less accurate. Start a new thread when possible to keep threads small and targeted."
```

그럼에도 6가지 방어 메커니즘으로 정확도 손실을 최소화한다:

#### 방어 1: Initial Context 완전 재주입

컴팩션 후 히스토리가 교체될 때 **시스템 프롬프트 전체를 현재 상태 기준으로 새로 빌드**한다.
이 부분은 요약되지 않는다.

```
컴팩션 후 히스토리 구성:

[fresh initial context]         ← 매번 새로 빌드, 절대 요약 안 됨
  ├─ DeveloperInstructions (sandbox, approval policy)
  ├─ developer_instructions (AGENTS.md 등)
  ├─ memory_tool instructions (memory_summary.md 포함!)
  ├─ collaboration_mode instructions
  ├─ personality instructions
  ├─ user_instructions
  └─ EnvironmentContext (cwd, shell)
[selected recent user messages]  ← 최근 20K 토큰 원문 보존
[compaction summary]             ← 모델이 생성한 요약
```

핵심: `build_initial_context()`가 **컴팩션 때마다 현재 상태 기준으로 새로 빌드**되므로
오래된 권한 설정이나 모델 지시가 stale해질 걱정이 없다.

#### 방어 2: 모드별 다른 injection 전략 (mid-turn vs. 나머지)

```
Pre-turn / Explicit compact (mid-turn 외 전부)
  └─ DoNotInject → reference_context_item = None 리셋
  └─ 다음 턴에서 자연스럽게 full context 재주입

Mid-turn compact (턴 중간, tool call 루프 도중)
  └─ BeforeLastUserMessage → initial context를 마지막 real user message 직전에 삽입
  └─ 모델이 학습 시 기대하는 메시지 순서(distribution)를 유지
```

#### 방어 3: 최근 User Messages 원문 보존 (요약 아님)

```rust
// compact.rs:393 — 역순으로 최근 메시지부터 선택, 원문 그대로
for message in user_messages.iter().rev() {
    if tokens <= remaining {
        selected_messages.push(message.clone());  // 원문 그대로
    } else {
        selected_messages.push(truncate_text(message, ...));
        break;
    }
}
```

20,000 토큰 예산 내에서 **가장 최근 user messages의 원문**을 보존한다.
이 메시지들이 "지금 뭘 하고 있었는지"의 가장 직접적인 단서가 된다.

#### 방어 4: Model Switch Instructions 보존

```rust
// 컴팩션 전에 추출 → 컴팩션 후에 재부착
let stripped = extract_trailing_model_switch_update_for_compaction_request(&mut history);
// ... 컴팩션 실행 ...
if let Some(model_switch_item) = stripped {
    new_history.push(model_switch_item);
}
```

모델 전환 지시(`<model_switch>`)는 컴팩션 대상에서 **제외**하고, 완료 후 재부착.

#### 방어 5: Ghost Snapshots 보존

`/undo` 기능을 위한 내부 상태. 모델에게는 보이지 않지만 컴팩션을 거쳐도 보존된다.

#### 방어 6: Pre-sampling Compact (선제 컴팩션)

```rust
// 모델 전환 시: 더 큰 윈도우를 가진 이전 모델로 먼저 compact
if total_usage_tokens > new_auto_compact_limit
    && old_context_window > new_context_window {
    run_auto_compact(sess, &previous_model_turn_context, ...).await?;
}
```

"터지기 전에 먼저 정리" 전략. 특히 모델을 큰 윈도우 → 작은 윈도우로 전환할 때
**이전(큰) 모델로** 컴팩션을 먼저 실행한다. 더 큰 컨텍스트를 볼 수 있는 모델이 요약하는 게 품질이 좋기 때문.

#### 컴팩션 후 정보 손실/보존 요약

| 잃어버리는 것 | 보존하는 것 |
|---|---|
| 과거 tool call/output 상세 내용 | 시스템 프롬프트 전체 (매번 새로 빌드) |
| 과거 assistant 응답 원문 | 최근 user messages 원문 (20K 토큰) |
| 중간 reasoning 과정 | 모델 전환 지시 |
| 오래된 context diffs | 컴팩션 요약 (진행 상황, 결정, 남은 작업) |
| | Memory 시스템의 장기 지식 (아래 참조) |

### 주요 상수
- `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` — 컴팩션 후 user message 보존 예산

---

## 2. Memory System (대화 간 장기 기억)

### Compaction과 Memory의 관계

**Compaction과 Memory는 완전히 별개의 시스템이다.**

```
Compaction (대화 내)              Memory System (대화 간)
───────────────────              ───────────────────
현재 세션의 히스토리 압축          과거 세션에서 지식 추출
→ 같은 세션 안에서만 유효         → 다른 세션에서 참조 가능
→ 컨텍스트 윈도우 관리 목적       → 장기 기억 목적
입력: 현재 세션 히스토리           입력: rollout 원본 파일 (JSONL)
```

Memory Phase 1이 읽는 것은 **컴팩션 요약이 아니라 rollout 원본 파일**이다:

```rust
// phase1.rs:290 — rollout 원본을 직접 읽음
let (rollout_items, _, _) = RolloutRecorder::load_rollout_items(rollout_path).await?;
```

`RolloutRecorder`는 **매 턴마다 모든 ResponseItem을 JSONL로 디스크에 기록**한다.
컴팩션 전이든 후든 상관없이, 대화의 **원본 전체 기록**이 항상 파일에 남아 있다.

### 현재 세션의 메모리 자기 참조는 불가능

**같은 세션에서 생성된 rollout을 같은 세션이 메모리로 참조하는 것은 불가능하다.**
3가지 메커니즘이 이를 방지한다:

#### 방지 1: 현재 thread 명시적 제외

```rust
// state/src/runtime/memories.rs:57-58
// excludes the current thread id
// updated_at <= now - min_rollout_idle_hours
```

`claim_stage1_jobs_for_startup(current_thread_id, ...)` — 현재 세션의 `thread_id`를 전달하여 SQL 쿼리에서 제외한다.

#### 방지 2: idle 시간 요구

```rust
// config/types.rs:28
pub const DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS: i64 = 6;
```

기본값 **6시간**. rollout의 `updated_at`이 `now - min_rollout_idle_hours` 이전이어야만 Phase 1 대상이 된다.
즉, 최소 6시간 이상 idle 상태인 "충분히 완료된" 과거 세션만 추출 대상.

#### 방지 3: 파이프라인은 세션 시작 시 1회만 실행

```rust
// start.rs:32-41 — tokio::spawn으로 fire-and-forget
phase1::run(&session, &config).await;
phase2::run(&session, config).await;
```

세션 도중이나 컴팩션 시점에 파이프라인이 재실행되지 않는다. 세션 시작 시 1회만 실행 (fire-and-forget).

### 다른 세션에서 참조 가능해지는 타이밍

```
세션 A 시작
  ├─ Memory Pipeline 1회 실행 (백그라운드, fire-and-forget)
  │   └─ 대상: 6시간+ idle된 과거 세션들 (세션 A 자신 제외)
  ├─ 세션 A 진행 중... (rollout JSONL에 계속 기록)
  ├─ 컴팩션 발생 → Memory Pipeline 재실행 없음
  └─ 세션 A 종료

(6시간+ 경과)

세션 B 시작
  ├─ Memory Pipeline 실행
  │   └─ Phase 1: 세션 A의 rollout 원본을 읽어서 메모리 추출
  │   └─ Phase 2: 통합 → memory_summary.md 업데이트
  └─ 이제 세션 B의 시스템 프롬프트에 세션 A의 지식이 반영
```

### 같은 세션 내에서의 Memory 참조 (2가지 경로)

Memory는 대화 "간" 시스템이지만, **같은 세션 내에서도 적극적으로 참조된다.**
이를 통해 컴팩션으로 잃어버린 디테일 중 일부를 보상할 수 있다.

#### 경로 1: Passive — 자동 주입

`build_initial_context()` → `build_memory_tool_developer_instructions()`:

```rust
// 매 턴 시작 시 (+ 컴팩션 후 재주입 시):
let memory_summary = fs::read_to_string(memory_summary_path).await.ok()?;
let memory_summary = truncate_text(&memory_summary, TruncationPolicy::Tokens(5_000));
// → developer instructions에 삽입
```

`memory_summary.md`가 **매 턴의 시스템 프롬프트에 항상 포함**된다.
컴팩션이 일어나도 재주입되므로, 사용자 프로필/프로젝트 컨벤션/일반 팁은 절대 잃어버리지 않는다.

#### 경로 2: Active — 에이전트가 직접 읽기

`read_path.md` 템플릿이 에이전트에게 메모리 폴더를 직접 열어보라고 지시한다:

```markdown
Quick memory pass (when applicable):
1) Skim the MEMORY_SUMMARY included below and extract task-relevant keywords
2) Search ~/.codex/memories/MEMORY.md for those keywords
3) If relevant rollout summary files and skills exist, open matching files
4) If nothing relevant turns up, proceed normally without memory

During execution: if you hit repeated errors, confusing behavior, or you
suspect there is relevant prior context, it is worth redoing the quick
memory pass.
```

에이전트는 `shell` tool로 MEMORY.md, rollout_summaries/, skills/를 직접 읽을 수 있다.
`usage.rs`가 이 접근을 메트릭으로 추적한다:

```rust
enum MemoriesUsageKind {
    MemoryMd,          // MEMORY.md 열람
    MemorySummary,     // memory_summary.md 열람
    RawMemories,       // raw_memories.md 열람
    RolloutSummaries,  // rollout_summaries/*.md 열람
    Skills,            // skills/*/ 열람
}
```

#### Compaction + Memory 상호 보완 시나리오

```
턴 1~10: 대화 진행
  ├─ 매 턴: memory_summary.md가 시스템 프롬프트에 포함
  ├─ 필요시: 에이전트가 MEMORY.md, rollout_summaries/ 직접 읽음
  └─ 대화 내용은 ContextManager (히스토리)에 있음

턴 11: 컴팩션 발생 (컨텍스트 윈도우 한도 도달)
  ├─ 히스토리 → 요약으로 압축 (과거 tool call 디테일 손실)
  ├─ initial context 재주입 (memory_summary.md 포함!)
  └─ 모델: "이 부분 정확히 기억 안 나는데..."

턴 12: 에이전트의 복구 경로
  ├─ 컴팩션 요약에서 방향과 진행 상황 파악
  ├─ memory_summary.md에서 사용자 선호/프로젝트 컨벤션 참조 (자동)
  ├─ 필요시 MEMORY.md에서 이 프로젝트의 검증된 워크플로우 조회 (능동)
  └─ 필요시 rollout_summaries/에서 과거 유사 작업의 구체적 커맨드/경로 조회 (능동)
```

**컴팩션으로 "이번 세션에서 5턴 전에 모델이 뭘 했는지"의 디테일은 잃어버리지만,
"이 프로젝트에서 이런 작업을 할 때는 이렇게 해야 한다" 수준의 지식은 Memory에서 보충 가능하다.**

Memory가 보상할 수 있는 것:
- 프로젝트 컨벤션, 디렉토리 구조, 진입점 → `MEMORY.md`
- 사용자 선호, 워크플로우 습관 → `memory_summary.md` (항상 주입)
- 과거 유사 작업의 검증된 커맨드/파일경로/에러 시그니처 → `rollout_summaries/`
- 반복 절차의 step-by-step → `skills/`

Memory가 보상할 수 없는 것:
- 현재 세션에서의 구체적 tool call 결과/출력
- 현재 작업의 중간 reasoning 과정
- 아직 Memory에 추출되지 않은 새 프로젝트의 지식

### 핵심 파일
- `core/src/memories/mod.rs` — 메모리 모듈 진입점 + 상수 정의
- `core/src/memories/start.rs` — 파이프라인 트리거
- `core/src/memories/phase1.rs` — Phase 1 추출
- `core/src/memories/phase2.rs` — Phase 2 통합
- `core/src/memories/prompts.rs` — 프롬프트 빌더 + memory_summary 주입
- `core/src/memories/storage.rs` — 파일시스템 동기화
- `core/src/memories/usage.rs` — 에이전트의 메모리 파일 접근 메트릭 추적
- `core/src/memories/README.md` — 파이프라인 아키텍처 문서
- `core/src/memories/tests.rs` — 테스트 모듈
- `core/templates/memories/stage_one_system.md` — Phase 1 시스템 프롬프트
- `core/templates/memories/stage_one_input.md` — Phase 1 유저 메시지 템플릿
- `core/templates/memories/consolidation.md` — Phase 2 프롬프트
- `core/templates/memories/read_path.md` — 에이전트에게 메모리 사용법을 알려주는 템플릿

### 아키텍처: 2-Phase 비동기 파이프라인

```
Session Start
    │
    ├─► Phase 1 (추출)
    │   ├─ 최대 5,000개 thread 스캔
    │   ├─ 적격한 rollout 선택 (max_rollouts_per_startup)
    │   ├─ 8개 병렬로 각 rollout에서 메모리 추출
    │   ├─ 모델: gpt-5.1-codex-mini, reasoning: Low
    │   ├─ 출력: {raw_memory, rollout_summary, rollout_slug}
    │   └─ SQLite에 저장
    │
    └─► Phase 2 (통합)
        ├─ global consolidation lock 획득
        ├─ Phase 1 출력물 로드
        ├─ rollout_summaries/ 파일 동기화
        ├─ raw_memories.md 재구성
        ├─ consolidation subagent 스폰
        │   ├─ 모델: gpt-5.3-codex, reasoning: Medium
        │   ├─ sandbox: workspace write only, no network
        │   └─ heartbeat: 90초 간격
        └─ 출력:
            ├─ MEMORY.md — 태스크별 학습 핸드북
            ├─ memory_summary.md — 시스템 프롬프트에 항상 주입
            └─ skills/ — 재사용 가능한 절차 (optional)
```

### 파일시스템 구조

```
~/.codex/memories/
├── memory_summary.md         ← 시스템 프롬프트에 항상 로드 (5,000 토큰 제한)
├── MEMORY.md                 ← 태스크별 학습 핸드북 (grep으로 검색)
├── raw_memories.md           ← Phase 1 병합 결과 (최신순, Phase 2 입력)
├── rollout_summaries/        ← 개별 대화 요약
│   ├── <slug1>.md
│   └── <slug2>.md
└── skills/                   ← 재사용 절차
    └── <skill-name>/
        ├── SKILL.md           ← 진입점 (YAML frontmatter + instructions)
        ├── scripts/           ← 헬퍼 스크립트
        ├── templates/         ← 출력 템플릿
        └── examples/          ← 예제
```

### Phase 1: 추출 (per-rollout)

**진입 조건**:
- ephemeral session이 아님
- MemoryTool feature 활성화
- SubAgent session이 아님 (root session만)
- state_db 사용 가능

**Rollout 선택 조건** (README.md에서):
- allowed interactive session sources에서 온 것
- configured age window 내
- **idle long enough** (아직 활성이거나 너무 최신인 rollout 제외)
- 다른 phase-1 worker가 소유하지 않은 것
- startup scan/claim 한도 내

**프로세스**:
1. `claim_startup_jobs` — DB에서 적격한 rollout 조회 + job claim
2. `build_request_context` — 모델 정보, turn context 준비
3. `run_jobs` — `buffer_unordered(8)` 로 8개 병렬 실행
4. 각 job: rollout 로드 → 필터링 → truncation → 모델 호출 → 결과 DB 저장 → 시크릿 제거

**Structured Output Schema**:
```json
{
  "rollout_summary": "string",  // 상세한 마크다운 요약
  "rollout_slug": "string",     // filesystem-safe slug, <=80 chars
  "raw_memory": "string"        // YAML frontmatter + task-grouped 마크다운
}
```

**No-op Gate**: "Will a future agent plausibly act better because of what I write here?"
→ 아니면 빈 문자열 반환 → 불필요한 메모리 생성 방지

**시크릿 처리**: `redact_secrets()` 로 토큰/키/패스워드를 `[REDACTED_SECRET]`으로 치환

### Phase 2: 통합 (global)

**프로세스**:
1. global phase-2 job claim (중복 실행 방지)
2. 에이전트 config 생성 (sandbox: workspace write only, no network, no collab)
3. DB에서 Phase 1 결과물 조회
4. 파일시스템 동기화: `rollout_summaries/`, `raw_memories.md`
5. consolidation subagent 스폰
6. heartbeat loop로 agent 상태 모니터링 (90초 간격)

**Consolidation 모드**:
- **INIT**: 첫 빌드 — 전체 파일 생성
- **INCREMENTAL UPDATE**: 기존 파일에 새 signal 통합

**출력물 형식 (엄격)**:

`memory_summary.md`:
- User Profile (<=500 words): 사용자 특성, 워크플로우, 선호도
- General Tips: 매 실행에 유용한 지식
- What's in Memory: MEMORY.md/skills/rollout_summaries 인덱스

`MEMORY.md`:
- `# Task Group: <topic>` + `scope:` 헤더
- `## Task N: <description>` 섹션:
  - `### rollout_summary_files` — 출처
  - `### keywords` — 검색 핸들
  - `### learnings` — 태스크별 학습 내용
- `## General Tips` — 중복 제거된 교차 태스크 가이드

`skills/`:
- SKILL.md: triggers + inputs + procedure + verification + efficiency plan
- scripts/: 헬퍼 스크립트
- templates/: 출력 템플릿

---

## 3. Context Manager (턴 단위 최적화)

### 핵심 파일
- `core/src/context_manager/mod.rs` — 모듈 진입점, re-exports
- `core/src/context_manager/history.rs` — ContextManager 핵심 구조체
- `core/src/context_manager/normalize.rs` — 히스토리 정규화
- `core/src/context_manager/updates.rs` — 턴 간 settings diff (5개 차원: env, permissions, collab mode, personality, model instructions)
- `core/src/context_manager/history_tests.rs` — 테스트
- `core/src/truncate.rs` — truncation 유틸리티
- `core/src/message_history.rs` — 전역 메시지 히스토리

### ContextManager 구조체

```rust
struct ContextManager {
    items: Vec<ResponseItem>,           // oldest → newest 순서
    token_info: Option<TokenUsageInfo>, // 토큰 사용량 추적
    reference_context_item: Option<TurnContextItem>, // diff 기준 스냅샷
}
```

### Truncation 전략

**중간 절삭 (Middle Truncation)**:
- 예산의 50%를 앞부분, 50%를 뒷부분에 할당
- 중간 부분 제거 + 마커 삽입: `TruncationPolicy::Tokens` → `…{N} tokens truncated…`, `TruncationPolicy::Bytes` → `…{N} chars truncated…`
- UTF-8 경계를 안전하게 처리

**토큰 추정**: `4 bytes ≈ 1 token` 휴리스틱 (실제 토크나이저 호출 없이 빠르게 추정)

```rust
const APPROX_BYTES_PER_TOKEN: usize = 4;

fn approx_token_count(text: &str) -> usize {
    text.len().saturating_add(3) / 4
}
```

**Tool Output Truncation**:
- function call output는 `policy * 1.2` 버짓으로 truncate (직렬화 오버헤드 고려)
- 여러 text item이 있으면 순차적으로 예산 소비, 초과 시 omission marker 추가

### Reference Context Diffing

```rust
// TurnContextItem을 기준으로 이전 턴과의 차이만 주입
reference_context_item: Option<TurnContextItem>
```

- 매 턴마다 전체 컨텍스트를 재주입하지 않고, **변경된 설정만 diff로 주입** → 토큰 절약
- `reference_context_item`이 None이면 전체 재주입 (컴팩션 후 등)
- **5개 diff 차원**: `updates.rs`에서 각각 독립적으로 diff 계산
  1. Environment context (`build_environment_update_item`)
  2. Permissions (`build_permissions_update_item`)
  3. Collaboration mode (`build_collaboration_mode_update_item`)
  4. Personality (`build_personality_update_item`)
  5. Model instructions (`build_model_instructions_update_item`)

```rust
// codex.rs — 두 경로 (별도의 코드패스)
if reference_context_item.is_none() {
    // 경로 1: build_initial_context()로 전체 재주입
    self.build_initial_context(turn_context).await
} else {
    // 경로 2: updates.rs의 build_settings_update_items()로 diff만
    self.build_settings_update_items(reference_context_item, ...)
}
```

### History Normalization

1. **call-output 쌍 무결성**: `FunctionCall`, `CustomToolCall`, `LocalShellCall` 모두에 대응하는 output 보장 (없으면 "aborted" 삽입). 역순 삽입으로 인덱스 안전성 확보.
2. **orphan output 제거**: call이 없는 `FunctionCallOutput`/`CustomToolCallOutput` 제거. HashSet으로 call ID 추적.
3. **이미지 스트리핑**: `input_modalities`에 `Image`가 없으면 `"image content omitted because you do not support image input"` placeholder로 대체
4. **call/output 쌍 연동 제거**: `remove_corresponding_for()`로 히스토리 아이템 제거 시 대응하는 call/output 쌍도 함께 제거

### Ghost Snapshots
- 내부 상태 추적용 아이템 (`ResponseItem::GhostSnapshot { ghost_commit: GhostCommit }`)
- `for_prompt()` 호출 시 `retain()`으로 제거 → 모델에게 보이지 않음, 0 바이트 비용
- 히스토리 복구/디버깅용으로 보존
- **참고**: 컴팩션 간 생존 여부와 `/undo` 직접 지원은 소스 코드에서 명시적으로 미확인 (추가 조사 필요)

### Model Switch Handling
- 모델 변경 시 `<model_switch>` developer message 삽입 (`DeveloperInstructions::model_switch_message()`)
- `updates.rs`의 `build_model_instructions_update_item()`이 모델 slug 변경 감지 시 생성
- 컴팩션 시 `extract_trailing_model_switch_update_for_compaction_request()`로 추출 → 컴팩션 완료 후 재부착 (`compact.rs:66-89`, `249-251`)
- 모델별 instruction 손실 방지

### Token Usage Tracking

```rust
struct TotalTokenUsageBreakdown {
    last_api_response_total_tokens: i64,
    all_history_items_model_visible_bytes: i64,
    estimated_tokens_of_items_added_since_last_successful_api_response: i64,
    estimated_bytes_of_items_added_since_last_successful_api_response: i64,
}
```

- 마지막 API 응답의 total_tokens + 그 이후 추가된 아이템의 추정 토큰
- 이미지: `image_data_url_estimate_adjustment()`로 data URL의 base64 payload를 분석하여 고정 **340 bytes (≈85 토큰)**으로 대체 추정 (`IMAGE_BYTES_ESTIMATE = 340`)
- Reasoning item: `estimate_reasoning_length()` → `encoded_len * 3/4 - 650` (saturating 산술)
- `server_reasoning_included` 파라미터로 서버 측 reasoning 토큰 포함 여부에 따라 추정 방식 조정

### Message History (전역 히스토리)

- `~/.codex/history.jsonl` — append-only JSON Lines
- 스키마: `{"session_id":"<thread_id>","ts":<unix_seconds>,"text":"<message>"}` (필드명은 하위 호환용으로 `session_id` 유지)
- `O_APPEND` + advisory file lock으로 원자적 쓰기 (최대 10회 재시도, 100ms 간격)
- Soft cap: 초과 시 80%로 트림 (최신 우선 보존, `HISTORY_SOFT_CAP_RATIO = 0.8`)
- 파일 권한: `0o600` (owner only)

---

## 4. 전체 시스템 상호작용 다이어그램

```
세션 시작
  │
  ├─[백그라운드] Memory Pipeline 시작
  │   ├─ Phase 1: 과거 rollout → raw_memory 추출
  │   └─ Phase 2: raw_memories → MEMORY.md, memory_summary.md, skills/ 통합
  │
  ├─[매 턴] Context Manager
  │   ├─ reference_context_item 있음? → settings diff만 주입 (토큰 절약)
  │   ├─ reference_context_item 없음? → build_initial_context() 전체 주입
  │   │   └─ memory_summary.md (5K 토큰) 포함
  │   ├─ tool output → truncation (policy * 1.2, middle truncation)
  │   └─ history normalization (call-output 쌍, orphan 제거, 이미지 스트리핑)
  │
  ├─[에이전트 판단] Memory Active Read (선택적)
  │   ├─ MEMORY.md에서 키워드 검색
  │   ├─ rollout_summaries/*.md에서 과거 유사 작업 참조
  │   └─ skills/에서 재사용 절차 로드
  │
  ├─[토큰 한도 도달] Compaction 발동
  │   ├─ Pre-turn: 턴 시작 전 선제 컴팩션
  │   │   └─ 모델 전환 시: 이전(큰) 모델로 먼저 compact
  │   ├─ Mid-turn: tool call 루프 중 컴팩션
  │   │   └─ initial context를 마지막 user message 직전에 주입
  │   └─ 결과: [initial context] + [최근 user msgs 원문] + [요약]
  │       └─ initial context에 memory_summary.md 다시 포함!
  │
  └─[세션 종료]
      └─ rollout JSONL 파일이 디스크에 남음 (컴팩션 여부 무관)
          └─ 다음 세션 시작 시 Memory Pipeline의 입력이 됨
```

---

## 5. Key Design Patterns

### Pattern 1: Handoff Framing
컴팩션을 "다른 LLM에게의 핸드오프"로 프레이밍 → 요약의 품질과 완결성 향상

### Pattern 2: Progressive Disclosure (Memory)
- Level 0: `memory_summary.md` (항상 시스템 프롬프트에 로드, 5K 토큰)
- Level 1: `MEMORY.md` (에이전트가 필요시 grep으로 검색)
- Level 2: `rollout_summaries/*.md` (상세 참조)
- Level 3: `skills/` (재사용 절차)

### Pattern 3: No-op Gate
"Will a future agent plausibly act better because of what I write here?"
→ 아니면 빈 출력. 노이즈 방지.

### Pattern 4: Evidence-based Memory
- 추측/가정 금지, 검증된 사실만 기록
- 시크릿 자동 제거
- 태스크 outcome 분류: success/partial/fail/uncertain

### Pattern 5: Structured Extraction
Phase 1 출력이 JSON schema로 제약 → 파싱 실패 없이 안정적 파이프라인

### Pattern 6: Async Background Pipeline
메모리 추출/통합이 세션 시작 시 백그라운드로 실행 → 사용자 체감 지연 없음

### Pattern 7: Job Leasing + Heartbeat
- Phase 1: 1시간 lease, 실패 시 1시간 후 재시도
- Phase 2: 1시간 lease + 90초 heartbeat
- 중복 실행 방지, 장애 복구 가능

### Pattern 8: Dual-path Memory Access
- Passive: `memory_summary.md`가 매 턴 시스템 프롬프트에 자동 주입
- Active: 에이전트가 `MEMORY.md`, `rollout_summaries/`, `skills/`를 직접 열어봄
- 메트릭 추적으로 실제 사용 패턴 관측 가능

### Pattern 9: Compaction-Memory Complementarity
- Compaction: 현재 세션의 "무엇을 하고 있었는지" 보존
- Memory: 프로젝트/사용자의 "어떻게 해야 하는지" 보존
- 두 시스템이 독립적이면서도 정보 손실을 상호 보상

---

## 6. FAQ

### Q1: 같은 세션에서 만들어진 메모리를 같은 세션이 참조할 수 있는가?

**아니요.** 3중 방지 메커니즘이 작동한다:
1. SQL 쿼리에서 `current_thread_id` 명시적 제외
2. `min_rollout_idle_hours` (기본 6시간) — 충분히 idle된 과거 세션만 대상
3. Memory Pipeline은 세션 시작 시 1회만 실행 (fire-and-forget), 세션 도중/컴팩션 시 재실행 없음

설계 의도: "충분히 완료된 과거 세션"만 메모리로 추출. 현재 세션의 지식은 Compaction으로 보존.

### Q2: 컴팩션 중에 Memory Pipeline이 실행되는가?

**아니요.** Memory Pipeline은 `start.rs`에서 `tokio::spawn`으로 세션 시작 시 1회만 fire-and-forget 실행된다. 컴팩션은 Memory Pipeline과 완전히 독립적인 시스템이다.

### Q3: Compaction과 Memory 중 어느 것이 "지금 하고 있는 작업"의 맥락을 유지하는가?

**Compaction.** 역할 분담이 명확하다:
- Compaction → 현재 세션의 "무엇을 하고 있었는지" (진행 상황, 결정, 남은 작업)
- Memory → 프로젝트/사용자의 "어떻게 해야 하는지" (컨벤션, 워크플로우, 과거 학습)

### Q4: 컴팩션 후 정보 손실을 Memory가 완전히 보상하는가?

**부분적으로만 가능.** Memory가 보상하는 것: 프로젝트 컨벤션, 사용자 선호, 과거 유사 작업의 검증된 커맨드/경로. Memory가 보상 못 하는 것: 현재 세션의 구체적 tool call 결과, 중간 reasoning, 아직 추출 안 된 새 프로젝트 지식.

### Q5: ContextWindowExceeded 에러가 발생하면 자동으로 컴팩션이 트리거되는가?

**아니요.** ContextWindowExceeded는 별도의 컴팩션 트리거가 아니라, 컴팩션 프로세스 **내부**의 에러 복구 메커니즘이다 (`compact.rs:194-204`). 컴팩션 요약을 생성하는 도중 윈도우를 초과하면 가장 오래된 히스토리 아이템을 제거하고 재시도한다.

### Q6: 컴팩션의 두 가지 injection 모드 차이는?

`InitialContextInjection` enum 기반. 구분은 "mid-turn vs. 나머지 전부":
- **Mid-turn** (`BeforeLastUserMessage`): 턴 중간 tool call 루프에서 발동. 모델이 학습 시 기대하는 메시지 순서를 유지하기 위해 initial context를 마지막 user message 직전에 삽입.
- **Pre-turn / Explicit** (`DoNotInject`): 턴 시작 전 또는 사용자 직접 요청. `reference_context_item`을 None으로 리셋, 다음 턴에서 전체 재주입.

---

## 7. 주요 상수 정리

| 상수 | 값 | 용도 |
|---|---|---|
| `APPROX_BYTES_PER_TOKEN` | 4 | 토큰 추정 휴리스틱 |
| `COMPACT_USER_MESSAGE_MAX_TOKENS` | 20,000 | 컴팩션 후 user message 보존 예산 |
| `MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT` | 5,000 | memory_summary.md 시스템 프롬프트 주입 한도 |
| `DEFAULT_STAGE_ONE_ROLLOUT_TOKEN_LIMIT` | 150,000 | Phase 1 rollout 기본 truncation 한도 |
| `CONTEXT_WINDOW_PERCENT` | 70% | Phase 1 모델 입력 윈도우 중 rollout에 할당하는 비율 |
| Phase 1 `CONCURRENCY_LIMIT` | 8 | Phase 1 병렬 추출 수 |
| Phase 1 `THREAD_SCAN_LIMIT` | 5,000 | Phase 1 스캔할 최대 thread 수 |
| Phase 1 `JOB_LEASE_SECONDS` | 3,600 | Phase 1 job 리스 시간 |
| Phase 2 `JOB_HEARTBEAT_SECONDS` | 90 | Phase 2 heartbeat 간격 |
| `HISTORY_SOFT_CAP_RATIO` | 0.8 | 히스토리 파일 soft cap, `message_history.rs` (max의 80%) |
| `IMAGE_BYTES_ESTIMATE` | 340 | 이미지 토큰 추정용 고정 바이트 (≈85 tokens) |

---

## 8. Deep-Dive Reference Index

다음 리서처가 더 깊이 파고들 때 참조할 파일 목록:

### Compaction 심화
| 파일 | 핵심 내용 |
|---|---|
| `core/src/compact.rs` | 전체 컴팩션 플로우, `build_compacted_history`, initial context injection |
| `core/src/compact_remote.rs` | OpenAI 전용 원격 컴팩션, `process_compacted_history`, `should_keep_compacted_history_item` |
| `core/templates/compact/prompt.md` | 컴팩션 프롬프트 원문 |
| `core/templates/compact/summary_prefix.md` | "다른 LLM에게 핸드오프" 프레임 |
| `core/src/codex.rs:4510-4960` | 컴팩션 트리거 로직: pre-turn, mid-turn, model switch 시 |

### Memory 심화
| 파일 | 핵심 내용 |
|---|---|
| `core/src/memories/phase1.rs` | job claiming, parallel sampling, `StageOneOutput` 파싱, secret redaction |
| `core/src/memories/phase2.rs` | subagent 스폰, sandbox config, heartbeat loop, watermark 관리 |
| `core/src/memories/prompts.rs` | `build_memory_tool_developer_instructions` (passive injection), stage-1 input 빌더 |
| `core/src/memories/storage.rs` | `sync_rollout_summaries_from_memories`, `rebuild_raw_memories_file` |
| `core/src/memories/usage.rs` | 에이전트의 메모리 파일 접근 메트릭 추적 (MemoriesUsageKind) |
| `core/src/memories/README.md` | Phase 1/2 아키텍처 설명, rollout 선택 조건, watermark 동작 |
| `core/templates/memories/stage_one_system.md` | Phase 1 시스템 프롬프트: no-op gate, outcome triage, deliverable format |
| `core/templates/memories/stage_one_input.md` | Phase 1 유저 메시지 템플릿 |
| `core/templates/memories/consolidation.md` | Phase 2 프롬프트: MEMORY.md/memory_summary.md/skills format |
| `core/templates/memories/read_path.md` | 에이전트에게 메모리 사용법 안내 (active read 유도), quick memory pass 절차 |

### Context Manager 심화
| 파일 | 핵심 내용 |
|---|---|
| `core/src/context_manager/history.rs` | ContextManager, record_items, for_prompt, estimate_token_count |
| `core/src/context_manager/normalize.rs` | call-output 쌍 무결성, orphan 제거, 이미지 스트리핑 |
| `core/src/context_manager/updates.rs` | 5개 차원 settings diff: env, permissions, collab mode, personality, model instructions |
| `core/src/context_manager/mod.rs` | 모듈 진입점 |
| `core/src/truncate.rs` | TruncationPolicy, middle truncation, function output truncation |
| `core/src/message_history.rs` | 전역 히스토리, append-only JSONL, soft cap enforcement |

### Session/Agent 심화
| 파일 | 핵심 내용 |
|---|---|
| `core/src/codex.rs:2738-2818` | `build_initial_context` — initial context 구성 (memory 포함) |
| `core/src/codex.rs:2842-2892` | `record_context_updates_and_set_reference_context_item` — diff vs full injection |
| `core/src/codex.rs:2820-2830` | `persist_rollout_items` — rollout 기록 |
| `core/src/rollout/recorder.rs` | RolloutRecorder — JSONL 기록/로드 |
| `core/src/codex_thread.rs` | thread 관리 (미조사 — 추가 조사 필요) |
| `core/src/session_prefix.rs` | 세션 시작 시 주입되는 프리픽스 (미조사 — 추가 조사 필요) |
| `core/src/environment_context.rs` | 환경 컨텍스트 빌드 (미조사 — 추가 조사 필요) |

### Collaboration Mode
| 파일 | 핵심 내용 |
|---|---|
| `core/templates/collaboration_mode/default.md` | 기본 모드 프롬프트 |
| `core/templates/collaboration_mode/execute.md` | 실행 모드 |
| `core/templates/collaboration_mode/plan.md` | 계획 모드 |
| `core/templates/collaboration_mode/pair_programming.md` | 페어 프로그래밍 모드 |
| `core/src/models_manager/collaboration_mode_presets.rs` | 모드 프리셋 (미조사) |

---