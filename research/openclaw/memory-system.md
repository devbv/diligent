# Reference Research: OpenClaw Memory System & Context Management

Date: 2026-02-23
Repo: https://github.com/openclaw/openclaw
Focus: `src/memory/` (84 files) + `src/agents/` context overflow management

---

## 1. 개요

OpenClaw는 로컬 퍼스트 개인 AI assistant로, `src/memory/`에 독립적인 벡터 + FTS 하이브리드 메모리 시스템을 구현했다. SQLite 기반 인덱스, 멀티 임베딩 프로바이더 지원, 시간 감쇠, MMR 다양성 랭킹 등 프로덕션급 설계를 갖추고 있다.

**핵심 특징:**
- Dual backend: 내장 `MemoryIndexManager` + 외부 `qmd` 바이너리 (fallback 구조)
- Storage: `node:sqlite` (실험적 빌트인 모듈) + `sqlite-vec` (벡터 확장)
- Source: `memory/` 파일들 (마크다운) + 세션 JSONL transcript
- 메모리 파일 경로: `~/.openclaw/workspace`

---

## 2. 아키텍처: 레이어 구조

```
┌─────────────────────────────────┐
│        search-manager.ts        │  ← 공개 진입점, fallback 오케스트레이션
├──────────────┬──────────────────┤
│  qmd-manager │  MemoryIndex     │  ← Primary / Fallback 백엔드
│  (external)  │  Manager         │
├──────────────┴──────────────────┤
│         hybrid.ts               │  ← Vector + FTS 결과 병합
├──────────┬──────────────────────┤
│  mmr.ts  │  temporal-decay.ts  │  ← 다양성 재랭킹 / 시간 감쇠
├──────────┴──────────────────────┤
│    embeddings-{provider}.ts     │  ← OpenAI / Gemini / Voyage / Mistral / Local
├─────────────────────────────────┤
│  memory-schema.ts + sqlite.ts   │  ← SQLite 스키마 및 벡터 DB
└─────────────────────────────────┘
```

---

## 3. 이중 백엔드 (Dual Backend)

### 3-1. 내장 백엔드: `MemoryIndexManager`

`manager.ts`에서 구현. `MemoryManagerEmbeddingOps`를 상속하며 `MemorySearchManager` 인터페이스를 구현한다.

```typescript
interface MemorySearchManager {
  search(query, opts?: { maxResults?, minScore? }): Promise<MemorySearchResult[]>
  readFile(params): Promise<string>
  status(): MemoryProviderStatus
  sync?(params?): Promise<void>   // optional
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
  probeVectorAvailability(): Promise<boolean>
  close?(): Promise<void>         // optional
}
```

**핵심 메서드:**
- `static async get()` — 싱글턴 팩토리 (캐시된 인스턴스 반환)
- `async search()` — 하이브리드 / FTS-only 모드 자동 선택
- `async sync()` — 파일시스템 → DB 동기화
- `async warmSession()` — 세션 시작 시 사전 준비
- `async probeVectorAvailability()` — 벡터 검색 가능 여부 체크
- `async probeEmbeddingAvailability()` — 임베딩 프로바이더 헬스체크

**Graceful Degradation:** 임베딩 프로바이더가 없어도 FTS만으로 동작.

### 3-2. 외부 백엔드: `QmdManager`

`qmd-manager.ts`. 외부 `qmd` CLI 바이너리에 위임하는 방식.

- Document collection을 glob 패턴으로 관리
- 검색 모드: `"query"` / `"vsearch"` / `"deep_search"`
- 에이전트별 격리된 SQLite 인덱스 (XDG 디렉토리 기반)
- `mcporter` 데몬과 선택적 연동
- 인덱스 동기화: 디바운싱 + 스케줄링 + 재시도

### 3-3. Fallback 오케스트레이션: `search-manager.ts`

```
getMemorySearchManager()
  → try QmdManager (primary)
  → on failure: FallbackMemoryManager wrapping MemoryIndexManager
```

`FallbackMemoryManager`가 모든 메서드를 try-catch로 감싸며, 실패 시 캐시를 무효화하고 fallback으로 투명하게 전환.

---

## 4. SQLite 스키마

`memory-schema.ts`가 `ensureMemoryIndexSchema()`로 다음 테이블을 초기화:

| 테이블 | 역할 |
|--------|------|
| `meta` | key-value 설정 저장 |
| `files` | 소스 파일 추적 (path, hash, mtime, size) |
| `chunks` | 텍스트 청크 + 임베딩 + 라인 번호 |
| `embedding_cache` | 프로바이더별 임베딩 캐시 |
| FTS5 virtual table | 전문 검색 인덱스 (선택적) |

SQLite 로드: `node:sqlite` (Node.js 실험적 빌트인), `requireNodeSqlite()`가 graceful error 처리.
벡터 연산: `sqlite-vec` 확장.

---

## 5. 임베딩 프로바이더

| 프로바이더 | 파일 | 기본 모델 | 토큰 한도 |
|-----------|------|-----------|---------|
| OpenAI | `embeddings-openai.ts` | `text-embedding-3-small` | 8,192 |
| Gemini | `embeddings-gemini.ts` | — | — |
| Voyage | `embeddings-voyage.ts` | — | — |
| Mistral | `embeddings-mistral.ts` | — | — |
| Local (llama) | `node-llama.ts` | — | — |
| Remote HTTP | `remote-http.ts` | — | — |

각 프로바이더는 `batch-*.ts`로 배치 처리를 별도 관리. 프로바이더 없으면 FTS로 자동 강등.

---

## 6. 하이브리드 검색 (`hybrid.ts`)

**점수 계산 공식:**
```
final_score = (vectorWeight × vectorScore) + (textWeight × textScore)
```

- BM25 정규화: `bm25RankToScore(rank) = 1 / (1 + rank)` → [0, 1] 범위
- FTS 쿼리 구성: Unicode 단어 토큰을 AND로 연결 (`buildFtsQuery()`)
- 벡터 + 키워드 결과를 ID 기준으로 병합 후 가중 합산
- 이후 temporal decay → MMR 재랭킹 (선택적)

---

## 7. 시간 감쇠 (`temporal-decay.ts`)

**공식:** `decay = e^(-λ × age_days)`, where `λ = ln(2) / halfLifeDays`

- 기본값: `enabled: false`, `halfLifeDays: 30`
- 30일 반감기 → 30일 후 점수 50% 감소
- 파일 나이 판별 전략:
  - `memory/YYYY-MM-DD.md` 형식 → 날짜 파싱
  - `MEMORY.md` / `memory.md` → 상시 파일, 감쇠 없음 (evergreen)
  - `memory/topic/*.md` 서브디렉토리 → evergreen 처리
  - 그 외 → 파일시스템 mtime 사용

---

## 8. MMR 다양성 랭킹 (`mmr.ts`)

**공식:** `score = λ × relevance - (1-λ) × max_sim_to_selected`

- λ 기본값: 0.7 (1이면 순수 관련성, 0이면 최대 다양성)
- 유사도 계산: **Jaccard similarity** on 토큰화된 텍스트 (alphanumeric, lowercase)
- 반복 선택: 매 스텝마다 MMR 점수 최고 후보를 선택
- 스코어 정규화: [0, 1] 범위로 정규화 후 비교

---

## 9. 쿼리 확장 (`query-expansion.ts`)

FTS용 키워드 추출 (임베딩 없을 때 활용).

- 다국어 불용어 필터: EN / ES / PT / AR / KO / JA / ZH
- 토크나이저: 스크립트별 분리 처리
  - 중국어: unigram + bigram
  - 일본어: kanji/kana/ASCII 청크
  - 한국어: 조사 제거 후 검증
- 결과: `"original query OR keyword1 OR keyword2"` OR 결합
- LLM 기반 확장 (`expandQueryWithLlm()`) 선택적 지원, 실패 시 로컬로 fallback

---

## 10. 메모리 소스 유형 (`types.ts`)

```typescript
type MemorySource = "memory" | "sessions"
```

두 가지 소스:
1. **`memory`**: 사용자가 직접 작성한 마크다운 파일들 (`~/.openclaw/workspace/memory/`)
2. **`sessions`**: 과거 세션 JSONL transcript (`session-files.ts`로 처리)

**세션 파일 처리 (`session-files.ts`):**
- JSONL에서 user/assistant 메시지 필터링
- 텍스트 정규화 (whitespace 축소)
- 민감 정보 redaction ("tools" 모드)
- 컨텐츠 해시 생성 (중복 제거)
- `lineMap`: 컨텐츠 라인 → 원본 JSONL 라인 매핑

---

## 11. 검색 결과 형식

```typescript
interface MemorySearchResult {
  path: string        // 파일 경로
  startLine: number   // 결과 시작 라인
  endLine: number     // 결과 끝 라인
  score: number       // 최종 점수
  snippet: string     // 해당 텍스트 스니펫
  source: MemorySource  // "memory" | "sessions"
  citation?: string   // 선택적 인용 출처
}
```

---

## 12. 핵심 설계 결정 및 시사점

| 결정 | OpenClaw 선택 | 우리 프로젝트 시사점 |
|------|--------------|-------------------|
| **스토리지** | `node:sqlite` (빌트인) + `sqlite-vec` | SQLite가 로컬 벡터 DB의 현실적 선택 |
| **이중 백엔드** | 내장 + 외부 qmd, transparent fallback | 고급/기본 기능 분리 패턴 참고 |
| **임베딩 없을 때** | FTS-only로 graceful degradation | 임베딩 의존성 제거 가능, optional feature |
| **메모리 소스** | 마크다운 파일 + 세션 transcript | 두 유형의 메모리 명확한 분리 |
| **파일 형식** | `YYYY-MM-DD.md` (daily) + `topic/*.md` (evergreen) | 날짜별 vs 주제별 메모리 분류 |
| **랭킹 파이프라인** | hybrid score → temporal decay → MMR | 3단계 랭킹 파이프라인 |
| **다국어** | 불용어 7개 언어, 스크립트별 토크나이저 | 한국어 포함, 조사 제거까지 처리 |
| **배치 임베딩** | 프로바이더별 별도 batch 모듈 | 대용량 인덱싱 시 배치 처리 필수 |

---

## 13. 우리 프로젝트와의 연관 레이어

- **L5 (Config)**: 임베딩 프로바이더 선택, 반감기 설정, 배치 크기 등 설정 연동
- **L6 (Session)**: 세션 JSONL이 메모리 소스 중 하나 (`"sessions"`)
- **L3 (Core Tools)**: 메모리 검색을 tool로 노출 (memory_search, memory_read 등)
- **L1 (Agent Loop)**: `warmSession()`으로 세션 시작 전 메모리 준비

이 리서치는 현재 프로젝트의 메모리 레이어 설계 결정 시 참고 자료로 활용.

---

---

# Part 2: Context Overflow & Compaction 관리

Focus: `src/agents/compaction.ts`, `src/agents/pi-embedded-runner/`, `src/agents/context-window-guard.ts`

---

## 14. Context Window 관리 전략 개요

OpenClaw는 LLM context window가 넘치지 않도록 다층 방어 전략을 사용한다.

```
┌────────────────────────────────────────────────────┐
│ Layer 1: Context Window Guard (실행 전 모델 검증)    │
├────────────────────────────────────────────────────┤
│ Layer 2: History Limit (채널/DM별 turn 수 제한)     │
├────────────────────────────────────────────────────┤
│ Layer 3: Tool Result Context Guard (실시간 truncate)│
├────────────────────────────────────────────────────┤
│ Layer 4: SDK Auto-Compaction (pi-coding-agent 내장) │
├────────────────────────────────────────────────────┤
│ Layer 5: Overflow 감지 → 명시적 Compaction 재시도   │
├────────────────────────────────────────────────────┤
│ Layer 6: Tool Result Truncation (oversized 복구)    │
└────────────────────────────────────────────────────┘
```

---

## 15. Layer 1: Context Window Guard

**파일:** `src/agents/context-window-guard.ts`

```typescript
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;  // 이 미만이면 실행 차단
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000; // 이 미만이면 경고 로그
```

**Context Window 크기 해결 우선순위:**
1. `modelsConfig` - 설정 파일에서 수동 지정 (가장 높은 우선순위)
2. `model` - 모델 메타데이터에서 자동 감지
3. `agentContextTokens` - 설정의 cap 값 (모델 값보다 작으면 적용)
4. `default` - DEFAULT_CONTEXT_TOKENS

**중복 모델 해결:** 같은 모델 ID로 여러 프로바이더에서 다른 context window를 보고할 경우 **더 작은 값** 선택 (fail-safe 전략).

---

## 16. Layer 2: History Turn Limit

**파일:** `src/agents/pi-embedded-runner/history.ts`

```typescript
function limitHistoryTurns(messages, limit):
  // 뒤에서부터 user 메시지를 카운트하여 limit 초과 시 slice
  // → 오래된 대화를 삭제하여 DM/채널 장기 세션 관리
```

설정 위치: `channels.{provider}.historyLimit` (채널), `channels.{provider}.dmHistoryLimit` (DM), `channels.{provider}.dms.{userId}.historyLimit` (개인별).

---

## 17. Layer 3: Tool Result Context Guard (실시간)

**파일:** `src/agents/pi-embedded-runner/tool-result-context-guard.ts`

Agent의 `transformContext` 훅을 monkey-patch하여 매 API 호출 직전에 실행:

```typescript
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;   // 토큰 추정 오차 보정
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5; // 단일 tool result 최대 50%
const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2; // tool result는 더 조밀

contextBudgetChars = contextWindowTokens * 4 * 0.75
maxSingleToolResultChars = contextWindowTokens * 2 * 0.5
```

**동작:**
1. 각 tool result를 `maxSingleToolResultChars`로 개별 truncate
2. 전체 context가 `contextBudgetChars` 초과 시 오래된 tool result부터 placeholder로 교체
3. placeholder: `"[compacted: tool output removed to free context]"`

---

## 18. Layer 4: SDK Auto-Compaction

pi-coding-agent SDK(`@mariozechner/pi-coding-agent`)가 내장 compaction을 수행. `session.compact()` 호출로 트리거됨.

**설정:** `applyPiCompactionSettingsFromConfig()`가 실행마다 적용

```typescript
compaction:
  mode: "default" | "safeguard"
  reserveTokens:         // 응답 생성용 헤드룸 (기본값 플로어: 20,000)
  keepRecentTokens:      // 최근 대화 최소 보존 토큰
  reserveTokensFloor:    // reserveTokens 최솟값 (0이면 비활성)
  maxHistoryShare:       // 히스토리가 차지할 수 있는 최대 비율 (0.1~0.9)
  memoryFlush:           // 컴팩션 직전 메모리 파일 기록 여부
    enabled: boolean
    softThresholdTokens: // 컴팩션까지 N토큰 남았을 때 flush 트리거
    prompt/systemPrompt: // 커스텀 flush 프롬프트
```

`DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000` — 항상 이 이상 유지.

---

## 19. Layer 5: Overflow 감지 & 명시적 Compaction

**파일:** `src/agents/pi-embedded-runner/run.ts`

```typescript
const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
```

**감지 방식:** `isLikelyContextOverflowError(errorText)` — 에러 메시지에서 overflow 키워드 탐지 (`"request_too_large"` 등).

**실행 루프의 overflow 처리 흐름:**

```
runEmbeddedAttempt() 실행
  → 에러 발생?
    → isLikelyContextOverflowError? YES
      ├─ SDK auto-compaction이 이미 일어났으면?
      │    → 컴팩션 없이 재시도
      ├─ overflowCompactionAttempts < MAX(3)?
      │    → compactEmbeddedPiSessionDirect() 명시적 실행
      │    → trigger="overflow"로 기록
      │    → 성공하면 루프 재시도
      │    → 실패하면 tool result truncation 시도
      ├─ sessionLikelyHasOversizedToolResults?
      │    → truncateOversizedToolResultsInSession() 실행
      │    → 성공하면 재시도
      └─ 모두 실패 → 에러 응답 반환
```

**Safety Timeout:** `EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000` (5분) — 컴팩션이 멈춰도 5분 후 강제 종료.

---

## 20. Layer 6: Tool Result Truncation (사후 복구)

**파일:** `src/agents/pi-embedded-runner/tool-result-truncation.ts`

overflow 발생 + compaction도 실패 + oversized tool result가 있을 때의 마지막 수단:

```typescript
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;  // 단일 tool result 최대 30%
const HARD_MAX_TOOL_RESULT_CHARS = 400_000; // 절대 상한 (2M 토큰 모델에서도)
const MIN_KEEP_CHARS = 2_000;               // 최소 보존 길이

maxChars = min(contextWindowTokens * 0.3 * 4, 400_000)
```

**세션 파일 수정 방식:**
1. SessionManager로 현재 branch 순회
2. oversized tool result 항목 찾기
3. 첫 oversized 항목의 `parentId`에서 branch 분기
4. 이후 항목들을 truncated tool result로 재append

truncation suffix: `"⚠️ [Content truncated — original was too large for the model's context window...]"`

---

## 21. Compaction 알고리즘 상세

**파일:** `src/agents/compaction.ts`

### 핵심 상수

```typescript
const BASE_CHUNK_RATIO = 0.4;   // 기본 청크 비율
const MIN_CHUNK_RATIO = 0.15;   // 최소 청크 비율
const SAFETY_MARGIN = 1.2;      // 토큰 추정 안전 마진 (20% 버퍼)
const SUMMARIZATION_OVERHEAD_TOKENS = 4096; // 요약 프롬프트용 오버헤드
```

### `pruneHistoryForContextShare()` — 히스토리 프루닝

```typescript
budgetTokens = maxContextTokens * maxHistoryShare (기본 0.5)
// while 루프: 토큰이 budget 초과하는 동안:
//   - 메시지를 parts개 청크로 분할
//   - 첫 청크 drop
//   - tool_use/tool_result 쌍 수리 (orphaned tool_result 제거)
```

보안 주석: `SECURITY: toolResult.details can contain untrusted/verbose payloads; never include in LLM-facing compaction.`

### `summarizeInStages()` — 단계적 요약

```
1. 메시지를 parts개(기본 2)로 토큰 기준 균등 분할
2. 각 청크를 generateSummary()로 개별 요약
3. 부분 요약들을 하나로 병합 요약
4. 실패 시 oversized 메시지 제외하고 재시도 (partial fallback)
5. 모두 실패 시: "Context contained N messages. Summary unavailable."
```

### `computeAdaptiveChunkRatio()` — 적응형 청크 크기

```typescript
// 평균 메시지 토큰이 context의 10% 초과 시 청크 비율 축소
if (avgRatio > 0.1):
  reduction = min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO)
  chunkRatio = max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction)
```

---

## 22. Compaction Hook 연동

`before_compaction` / `after_compaction` 플러그인 훅이 fire-and-forget으로 실행됨:

- `before_compaction`: 컴팩션 시작 직전, 세션 JSONL 파일에 메시지가 이미 저장된 상태 → 플러그인이 비동기로 파일 읽기 가능
- `after_compaction`: 컴팩션 완료 후, 메시지 수 / 토큰 수 / 컴팩션된 메시지 수 전달

---

## 23. 전체 Context 관리 설계 결정 및 시사점

| 결정 | OpenClaw 선택 | 우리 프로젝트 시사점 |
|------|--------------|-------------------|
| **Overflow 감지** | 에러 메시지 텍스트 패턴 매칭 | provider API마다 다른 에러 형식 → 정규화 필요 |
| **컴팩션 트리거** | SDK 자동 + overflow 감지 후 명시적 | 두 레이어가 보완 관계 |
| **최대 재시도** | overflow compaction 3회 | 무한 루프 방지 필수 |
| **Safety Timeout** | 5분 하드 제한 | 컴팩션 자체가 블로킹 작업임을 고려 |
| **Tool result 크기** | 컨텍스트의 30%, 최대 400K chars | 단일 tool output 상한이 핵심 |
| **토큰 추정** | `chars/4` 휴리스틱 + 20% 마진 | 정확한 토크나이저 없이 실용적 근사 |
| **세션 수정** | branch + re-append 패턴 | 세션 불변성 유지하며 과거 항목 수정 |
| **memoryFlush** | 컴팩션 직전 메모리 파일 기록 | 중요 컨텍스트 손실 전 영속화 |
| **히스토리 제한** | 채널/DM/개인별 turn 수 제한 | 소셜 채널에서 장기 세션 관리 |
| **Hook 연동** | 컴팩션 전후 플러그인 훅 | 외부 분석/로깅 통합 포인트 |

---

## 24. 우리 프로젝트 연관 레이어 (Context 관리)

- **L1 (Agent Loop)**: overflow 감지 및 재시도 로직, compaction 트리거 위치
- **L5 (Config)**: compaction 설정 (reserveTokens, maxHistoryShare 등)
- **L6 (Session)**: SessionManager branch/re-append 패턴, JSONL 구조
- **L3 (Core Tools)**: tool result 크기 제한 정책
- **L8 (Skills/Hooks)**: before_compaction / after_compaction 훅 연동
