# LLM-Native Tools 비교 분석: OpenAI vs Anthropic vs Google

**Date**: 2026-02-24
**Purpose**: Agent 구현 시 각 LLM의 tool 생태계 차이를 이해하고, 멀티-모델 지원을 위한 설계 고려사항 도출

---

## 1. 각 LLM 제공사별 Tool 전체 목록

### 1.1 OpenAI

#### Codex CLI (로컬 에이전트) - 16+ tools
| Tool | 카테고리 | 특이사항 |
|------|---------|---------|
| `apply_patch` | 파일 편집 | **V4A 커스텀 diff 포맷**, Lark 문법 기반 freeform tool |
| `shell` | 명령 실행 | array 기반 (execvp), sandbox_permissions 포함 |
| `shell_command` | 명령 실행 | string 기반 |
| `exec_command` | 명령 실행 | PTY 기반 인터랙티브 세션 |
| `write_stdin` | 명령 실행 | 실행 중인 PTY 세션에 입력 전송 |
| `read_file` | 파일 읽기 | **indentation mode**: 들여쓰기 기반 코드 블록 확장 |
| `list_dir` | 탐색 | depth 파라미터 지원 |
| `grep_files` | 검색 | 수정시간 순 결과 반환 |
| `update_plan` | 계획 | step/status 기반 계획 추적 |
| `view_image` | 미디어 | 로컬 이미지 표시 |
| `js_repl` | 코드 실행 | **freeform tool** (Lark 문법), persistent Node.js 커널 |
| `js_repl_reset` | 코드 실행 | REPL 초기화 |
| `spawn_agent` | 멀티 에이전트 | 서브 에이전트 생성 |
| `send_input` / `resume_agent` / `wait` / `close_agent` | 멀티 에이전트 | 에이전트 제어 |
| `request_user_input` | 사용자 상호작용 | 질문 및 응답 대기 |
| `search_tool_bm25` | 도구 검색 | BM25 기반 MCP/앱 도구 검색 |
| MCP 리소스 도구들 | MCP | list/read MCP 리소스 |

#### Responses API (호스팅 도구) - 9 types
| Tool | 실행 위치 | 특이사항 |
|------|----------|---------|
| `web_search` | 서버 | 도메인 필터링, 위치 기반 검색 |
| `file_search` | 서버 | 벡터 스토어 기반 시맨틱 검색 |
| `code_interpreter` | 서버 | 샌드박스 Python 컨테이너 (1-64GB) |
| `computer_use_preview` | 클라이언트 | CUA 모델 기반 스크린샷 제어 |
| `apply_patch` | 하이브리드 | GPT-5.1+에서 first-class built-in |
| `shell` (hosted) | 서버 | Debian 12 컨테이너, 네트워크 allowlist |
| `shell` (local) | 클라이언트 | 로컬 명령 실행 |
| `image_generation` | 서버 | gpt-image 모델 인라인 호출 |
| `mcp` | 원격 | 원격 MCP 서버 연결 |

---

### 1.2 Anthropic

#### Claude Code CLI - ~24 tools
| Tool | 카테고리 | 특이사항 |
|------|---------|---------|
| `Read` | 파일 읽기 | 이미지/PDF/ipynb 지원, cat -n 출력 |
| `Write` | 파일 쓰기 | 기존 파일은 Read 선행 필수 |
| `Edit` | 파일 편집 | **str_replace 패러다임**: old_string→new_string 정확 매칭 |
| `MultiEdit` | 파일 편집 | 단일 파일 다중 편집 |
| `NotebookEdit` | 노트북 | Jupyter cell 단위 편집 |
| `Glob` | 파일 검색 | glob 패턴, 수정시간 순 |
| `Grep` | 내용 검색 | ripgrep 기반, 다중 출력 모드 |
| `Bash` | 명령 실행 | persistent 세션, description 파라미터 |
| `WebFetch` | 웹 | URL+prompt 분리, AI 모델로 처리 |
| `WebSearch` | 웹 | 도메인 필터링, 마크다운 링크 반환 |
| `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` | 태스크 관리 | 의존성(blocks/blockedBy) 지원 |
| `TodoWrite` | 태스크 관리 | 레거시, 대화 범위 단기 메모리 |
| `EnterPlanMode`/`ExitPlanMode` | 계획 | 읽기 전용 모드 전환 |
| `Task` (sub-agent) | 멀티 에이전트 | 모델 계층화 (Haiku/Sonnet/Opus) |
| `AskUserQuestion` | 사용자 상호작용 | 구조화된 질문+선택지 |
| `Skill` | 스킬 | SKILL.md 기반 모듈 실행 |
| `EnterWorktree` | Git | 격리된 worktree 생성 |
| `ToolSearch` | 도구 검색 | 동적 도구 발견 |

#### Anthropic API Built-in Tools - 7 types
| Tool | 버전 | Schema-less | 실행 위치 |
|------|------|-----------|----------|
| Text Editor | `text_editor_20250728` | Yes | 클라이언트 |
| Bash | `bash_20250124` | Yes | 클라이언트 |
| Computer Use | `computer_20251124` | Yes | 클라이언트 |
| Web Search | `web_search_20260209` | Yes | **서버** |
| Web Fetch | `web_fetch_20260209` | Yes | **서버** |
| Code Execution | `code_execution_20250825` | Yes | **서버** |
| Tool Search | `tool_search_tool_regex_20251119` | Yes | 서버 |

---

### 1.3 Google (Gemini)

#### Gemini CLI - 17 tools
| Tool | 카테고리 | 특이사항 |
|------|---------|---------|
| `read_file` | 파일 읽기 | 텍스트/이미지/오디오/PDF 지원 |
| `write_file` | 파일 쓰기 | 사용자가 content 수정 가능 |
| `read_many_files` | 파일 읽기 | glob 패턴으로 **대량 읽기** |
| `replace` | 파일 편집 | str_replace + **`instruction` 파라미터** (필수) |
| `glob` | 파일 검색 | .gitignore/.geminiignore 존중 |
| `grep_search` | 내용 검색 | ripgrep 기반, exclude/fixed_strings 지원 |
| `list_directory` | 탐색 | 파일 필터링 옵션 |
| `run_shell_command` | 명령 실행 | 플랫폼 인식 (Win/Unix), background 지원 |
| `google_web_search` | 웹 | **grounded search** (인용 포함) |
| `web_fetch` | 웹 | URL+prompt 통합, 최대 20개 URL |
| `write_todos` | 태스크 관리 | **전체 목록 교체 방식** |
| `save_memory` | 메모리 | **전역 사실만**, 워크스페이스 독립 |
| `get_internal_docs` | 자기 지식 | CLI 자체 문서 조회 |
| `activate_skill` | 스킬 | enum 제약 스킬 활성화 |
| `ask_user` | 사용자 상호작용 | **choice/text/yesno** 타입, multiSelect |
| `enter_plan_mode`/`exit_plan_mode` | 계획 | 읽기 전용 도구 제한 |

#### Gemini API Built-in Tools - 6 types
| Tool | 실행 위치 | 특이사항 |
|------|----------|---------|
| Google Search | 서버 | grounding 메타데이터+인용 |
| Code Execution | 서버 | Python 전용, 30초 제한, 무료 |
| URL Context | 서버 | 2단계 캐시 (인덱스→라이브), 최대 20 URL |
| Google Maps | 서버 | 위치 기반 grounding, 2.5억+ 장소 |
| Computer Use | 클라이언트 | 정규화된 1000x1000 좌표계 |
| File Search | 서버 | 완전 관리형 RAG, 자동 청킹/임베딩 |

---

## 2. 동일 이름/개념의 Tool인데 철학이 다른 것들

### 2.1 파일 편집 (Edit) — 가장 큰 차이

| | OpenAI `apply_patch` | Anthropic `Edit` | Google `replace` |
|--|---------------------|-----------------|-----------------|
| **접근법** | diff 기반 (V4A 커스텀 포맷) | 정확한 문자열 교체 | 정확한 문자열 교체 + instruction |
| **포맷** | `*** Begin Patch`...`*** End Patch` | `old_string` → `new_string` | `old_string` → `new_string` + `instruction` |
| **컨텍스트** | 3줄 위/아래 + `@@` 헤더로 위치 특정 | 유니크 매칭 (겹치면 더 많은 컨텍스트 필요) | 유니크 매칭 + 시맨틱 설명 |
| **다중 편집** | 하나의 패치에 여러 hunk | MultiEdit tool 별도 | `allow_multiple` 파라미터 |
| **파일 생성/삭제** | 패치 안에 `Add File`/`Delete File` | Write tool 별도 | write_file tool 별도 |
| **출력 형식** | **freeform** (JSON 아님, Lark 문법) | JSON | JSON |
| **모델 학습** | V4A 포맷에 특화 학습 | str_replace에 특화 학습 | str_replace에 학습 + instruction으로 보정 |
| **실패 시** | context 매칭 실패 → 재시도 | unique 매칭 실패 → 에러 | unique 매칭 실패 → **LLM 기반 edit correction** 가능 |

**핵심 차이**: OpenAI는 diff 기반, Anthropic/Google은 str_replace 기반. Google은 `instruction` 파라미터로 "왜 이 변경인가"를 요구하여 edit correction에 활용.

### 2.2 Shell 실행 (Bash/Shell)

| | OpenAI | Anthropic | Google |
|--|--------|-----------|--------|
| **Tool 이름** | `shell` / `shell_command` / `exec_command` (3종) | `Bash` (1종) | `run_shell_command` (1종) |
| **커맨드 형식** | array (execvp) 또는 string | string | string (`bash -c <command>`) |
| **PTY 지원** | `exec_command`로 PTY 세션 + `write_stdin`으로 입력 | 미지원 | 미지원 |
| **권한 관리** | `sandbox_permissions` + `justification` (스키마 내장) | permission 모드 (외부 레이어) | seatbelt 샌드박스 (외부 레이어) |
| **작업 디렉토리** | `workdir` 파라미터 (필수 권장) | 세션 간 유지 (absolute path 권장) | `dir_path` 파라미터 |
| **백그라운드** | PTY 세션으로 관리 | `run_in_background` 파라미터 | `is_background` 파라미터 |
| **description** | 없음 | `description` 파라미터 (사용자 표시용) | `description` 파라미터 (사용자 표시용) |

**핵심 차이**: OpenAI만 PTY 인터랙티브 세션 지원. 권한 모델이 스키마 내장(OpenAI) vs 외부 레이어(Anthropic/Google).

### 2.3 파일 읽기 (Read/read_file)

| | OpenAI `read_file` | Anthropic `Read` | Google `read_file` |
|--|-------------------|-----------------|-------------------|
| **기본 모드** | offset + limit (slice) | offset + limit | start_line + end_line |
| **특수 모드** | **indentation mode** (들여쓰기 레벨 기반 코드 블록 확장) | 없음 | 없음 |
| **멀티미디어** | 이미지 (view_image 별도) | 이미지, PDF, ipynb | 이미지, 오디오, PDF |
| **대량 읽기** | 없음 | 없음 | `read_many_files` (glob 기반) |
| **출력 형식** | 1-indexed 라인 번호 | cat -n 형식 (1-indexed) | 명시 안됨 |

**핵심 차이**: OpenAI의 indentation mode는 코드 탐색에 독보적. Google의 `read_many_files`는 대량 파일 읽기에 유용.

### 2.4 태스크 관리 (Plan/Todo)

| | OpenAI `update_plan` | Anthropic `TaskCreate`+`TaskUpdate` | Google `write_todos` |
|--|---------------------|-------------------------------------|---------------------|
| **업데이트 방식** | 전체 plan 배열 교체 | 개별 태스크 CRUD | **전체 목록 교체** |
| **의존성** | 없음 | `blocks` / `blockedBy` 지원 | 없음 |
| **상태** | pending/in_progress/completed | pending/in_progress/completed/deleted | pending/in_progress/completed/**cancelled** |
| **소유자** | 없음 | `owner` 파라미터 | 없음 |
| **설명** | `step` (단일 문자열) | `subject` + `description` + `activeForm` | `description` (단일 문자열) |

**핵심 차이**: Anthropic만 태스크 간 의존성과 소유자 지원. OpenAI/Google은 단순 리스트.

### 2.5 웹 검색 (Web Search)

| | OpenAI `web_search` | Anthropic `WebSearch` | Google `google_web_search` |
|--|--------------------|-----------------------|--------------------------|
| **실행 위치** | 서버 (Responses API) / 모델 내 (Codex CLI) | 서버 (API) / 클라이언트 (CLI) | 서버 (API) / 클라이언트 (CLI) |
| **인용** | URL+콘텐츠 반환 | `web_search_result_location` 인용 | **grounding metadata** (쿼리, 소스, 텍스트-소스 매핑) |
| **도메인 필터** | allow_list (최대 100개) | allowed_domains / blocked_domains | 없음 (API) |
| **위치 인식** | country/city/region | city/region/country/timezone | 없음 (기본) |

**핵심 차이**: Google의 grounding metadata가 가장 풍부 (텍스트 세그먼트→소스 매핑). Anthropic은 양방향 도메인 필터링.

### 2.6 Computer Use

| | OpenAI | Anthropic | Google |
|--|--------|-----------|--------|
| **좌표계** | 절대 픽셀 좌표 | 절대 픽셀 좌표 | **정규화 1000x1000 그리드** |
| **해상도 관리** | display_width/height 설정 | display_width_px/height_px 설정 | 정규화로 해상도 무관 |
| **줌** | 없음 | `zoom` 액션 (20251124+) | 없음 |
| **안전** | 없음 (사용자 책임) | prompt injection 분류기 | **`safety_decision` 필드** (regular/require_confirmation) |
| **네비게이션** | 없음 | 없음 | `navigate`, `go_back`, `go_forward` 내장 |
| **모델** | computer-use-preview (전용) | Claude 4.x/3.x (범용) | gemini-computer-use-preview (전용) |

**핵심 차이**: Google은 정규화 좌표+안전 결정 내장. Anthropic은 줌 기능. OpenAI는 가장 기본적.

### 2.7 사용자 질의 (Ask User)

| | OpenAI `request_user_input` | Anthropic `AskUserQuestion` | Google `ask_user` |
|--|-----------------------------|---------------------------|-------------------|
| **질문 수** | 단일 | 1-4개 | 1-4개 |
| **질문 타입** | 자유 텍스트 | 선택지 (2-4개) + 자유 텍스트 | **choice / text / yesno** |
| **다중 선택** | 미지원 | `multiSelect` 지원 | `multiSelect` 지원 |
| **미리보기** | 미지원 | `markdown` 미리보기 (코드/UI 비교) | 미지원 |
| **구조화 수준** | 최저 | 중간 | **최고** (타입별 분화) |

---

## 3. Agent 구현 시 핵심 고려사항

### 3.1 파일 편집 전략 — 모델별 최적 방식이 다르다

```
OpenAI 모델 → apply_patch (V4A diff format) 사용해야 함
  - 모델이 V4A 포맷에 특화 학습됨
  - freeform output (JSON이 아닌 raw text)
  - Lark 문법으로 constrained decoding 가능

Anthropic 모델 → str_replace (old_string → new_string)
  - 모델이 str_replace 패턴에 특화 학습됨
  - JSON 기반 tool call
  - 유니크 매칭 보장 필요

Google 모델 → str_replace + instruction
  - Anthropic과 유사하지만 instruction 파라미터 필수
  - LLM 기반 edit correction 활용 가능
```

**설계 함의**: 멀티-모델 에이전트에서 파일 편집 tool은 **모델 제공사별로 다른 구현체**를 제공해야 한다. 통합 인터페이스 뒤에 모델별 어댑터 패턴이 필요.

### 3.2 Freeform Tools — OpenAI 고유의 혁신

OpenAI는 `apply_patch`와 `js_repl`에서 **JSON이 아닌 raw text output**을 사용한다:

```
일반 tool: 모델 → JSON 생성 → 파싱 → 실행
freeform: 모델 → Lark 문법으로 constrained raw text → 파싱 → 실행
```

**장점**: JSON 이스케이핑 오버헤드 없음 (대형 diff/코드에 유리)
**단점**: 현재 OpenAI만 지원, 표준화되지 않음

**설계 함의**: OpenAI 모델 사용 시 freeform tool을 활용하면 성능 향상. 다만 다른 모델에는 JSON fallback 필요.

### 3.3 Schema-less vs Schema-defined — Anthropic의 차별화

Anthropic의 API built-in tools (Text Editor, Bash, Computer Use)는 공식적으로 **"schema-less tool"**이라 불리며, "the schema is built into Claude's model and can't be modified" (공식 문서 원문). input_schema가 필요 없다:

```python
# Anthropic: schema-less (모델 가중치에 내장)
tools = [{"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"}]

# OpenAI: schema 필요 (또는 freeform grammar)
tools = [{"type": "function", "function": {"name": "...", "parameters": {...}}}]

# Google: schema 필요 (OpenAPI 3.0.3 subset)
tools = [{"function_declarations": [{"name": "...", "parameters": {...}}]}]
```

**설계 함의**: Anthropic API 사용 시 built-in tool을 우선 활용하면 토큰 절약+정확도 향상. 다른 모델에는 동일 기능의 schema-defined tool 제공 필요.

### 3.4 Function Calling 프로토콜 차이

| 측면 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| **스키마 형식** | JSON Schema (strict mode) | JSON Schema | OpenAPI 3.0.3 subset |
| **강제 호출 모드** | `required` / 특정 함수 지정 | `any` / `tool` | `ANY` / `allowed_function_names` |
| **병렬 호출** | 지원 (strict와 비호환) | 지원 | 지원 |
| **구조화 출력 보장** | `strict: true` (100% 준수) | tool_use에서 보장 | `VALIDATED` 모드 |
| **사고 서명** | 없음 | 없음 | **필수** (Gemini 3, `thought_signature`) |
| **체이닝** | 수동 | 수동 | **compositional** (모델 내부 체이닝) |
| **자동 실행** | 미지원 | 미지원 | Python SDK에서 지원 |

**설계 함의**:
- **Gemini 3의 thought_signature**: 수동 API 호출 시 반드시 관리해야 함 (SDK 사용 권장)
- **OpenAI strict mode**: `additionalProperties: false` + 모든 필드 required 강제
- **Google compositional calling**: 모델이 내부적으로 tool 체이닝 → 클라이언트 라운드트립 감소

### 3.5 Context Window 최적화 — 각사의 접근법

| 전략 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| **Tool 지연 로딩** | `search_tool_bm25` | `tool_search` (85% 토큰 감소) | 미확인 |
| **프로그래매틱 호출** | 없음 | Code Execution에서 tool 호출 (37% 감소) | 없음 |
| **사용 예제** | system prompt에 배치 | `input_examples` (72%→90% 정확도) | 없음 |
| **추론 지속성** | `previous_response_id` | 대화 컨텍스트 | 자동 (멀티턴) |
| **파일 읽기 최적화** | indentation mode | offset+limit | `read_many_files` (대량) |

**설계 함의**:
- Tool 수가 많아질수록 Tool Search/지연 로딩 필수
- Anthropic의 programmatic tool calling은 중간 결과를 컨텍스트에 넣지 않아 효율적
- 모델별 최적화 전략이 다르므로 어댑터 레이어에서 처리

### 3.6 보안/권한 모델 차이

| 측면 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| **권한 위치** | Tool 스키마 내장 (`sandbox_permissions`) | 외부 레이어 (permission 모드) | 외부 레이어 (seatbelt 샌드박스) |
| **정당화** | `justification` 파라미터 | Hook 시스템 | 없음 |
| **URL 제한** | 네트워크 allowlist (shell) | 대화 내 URL만 fetch 가능 | 없음 (localhost 허용) |
| **Computer Use 안전** | 없음 | prompt injection 분류기 | `safety_decision` 필드 |

**설계 함의**: 권한 모델을 tool 스키마에 내장(OpenAI 방식)할지, 외부 오케스트레이션 레이어에 둘지(Anthropic 방식) 결정 필요. 후자가 모델 독립적.

### 3.7 멀티 에이전트 / 서브 에이전트

| 측면 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| **서브에이전트 모델** | 동일 모델 | **모델 계층화** (Haiku/Sonnet/Opus) | XML 기반 서브에이전트 위임 |
| **에이전트 제어** | spawn/send/resume/wait/close (5개 tool) | Task tool (단일) | 명시적 도구 없음 |
| **에이전트 통신** | 입력 전송 + 결과 대기 | prompt → result (단방향) | 시스템 프롬프트 기반 |

**설계 함의**: Anthropic의 모델 계층화(빠른 탐색=Haiku, 계획=Sonnet, 실행=Opus)는 비용/속도 최적화에 효과적. OpenAI의 세밀한 에이전트 제어(resume, wait)는 복잡한 워크플로우에 유리.

### 3.8 AGENTS.md / CLAUDE.md / GEMINI.md — 리포지토리 지시 파일

| | OpenAI | Anthropic | Google |
|--|--------|-----------|--------|
| **파일명** | `AGENTS.md` | `CLAUDE.md` | `GEMINI.md` |
| **스코프** | 디렉토리 트리 기반 중첩 (가장 가까운 것 우선) | 프로젝트 + 사용자 수준 | 프로젝트 수준 |
| **무시 파일** | `.gitignore` | `.gitignore` | `.gitignore` + **`.geminiignore`** |

**설계 함의**: 멀티-모델 에이전트라면 `AGENTS.md`(OpenAI), `CLAUDE.md`(Anthropic), `GEMINI.md`(Google) 모두 읽어야 한다. 혹은 범용 지시 파일 포맷을 정의.

---

## 4. 멀티-모델 에이전트 설계를 위한 아키텍처 제안

### 4.1 Tool Adapter Layer (핵심)

```
┌─────────────────────────────────────┐
│         Agent Core (통합 인터페이스)    │
│  edit_file(), run_command(), search()│
├─────────────────────────────────────┤
│          Tool Adapter Layer          │
│  ┌──────────┬──────────┬──────────┐ │
│  │ OpenAI   │ Anthropic│ Google   │ │
│  │ Adapter  │ Adapter  │ Adapter  │ │
│  ├──────────┼──────────┼──────────┤ │
│  │apply_    │str_      │str_      │ │
│  │patch(V4A)│replace   │replace+  │ │
│  │freeform  │JSON      │instruction│
│  │          │          │JSON      │ │
│  └──────────┴──────────┴──────────┘ │
├─────────────────────────────────────┤
│        Tool Execution Layer          │
│   (실제 파일 시스템 / 프로세스 조작)     │
└─────────────────────────────────────┘
```

### 4.2 편집 전략 결정 매트릭스

| 모델 | 편집 방식 | tool 포맷 | 실패 복구 |
|------|---------|----------|----------|
| GPT-4.1+ | V4A diff (freeform) | Lark grammar → raw text | context 재매칭 |
| GPT-5+ | apply_patch (built-in) | apply_patch_call object | API 에러 처리 |
| Claude 4.x | str_replace (schema-less) | built-in tool | 더 많은 컨텍스트 제공 |
| Claude 3.x | str_replace (schema-defined) | JSON tool call | 동일 |
| Gemini 3 | str_replace + instruction | JSON + thought_signature | LLM edit correction |
| Gemini 2.x | str_replace | JSON (legacy descriptions) | 동일 |

### 4.3 반드시 모델별로 달라져야 하는 것들

1. **파일 편집 tool 포맷** — 모델이 학습된 포맷과 일치해야 성능 최대화
2. **Tool description 텍스트** — 모델 패밀리별 최적화된 설명 (Google이 선례)
3. **Function calling 프로토콜** — strict mode / VALIDATED / thought_signature 등
4. **Schema 형식** — JSON Schema (OpenAI/Anthropic) vs OpenAPI subset (Google)
5. **Agentic prompting** — 모델별 최적 시스템 프롬프트 패턴이 다름

### 4.4 통합 가능한 것들 (모델 독립적)

1. **Tool 실행 레이어** — 실제 파일/프로세스 조작은 모델과 무관
2. **권한/보안 모델** — 외부 오케스트레이션 레이어에서 통합 관리
3. **태스크 관리** — 내부 상태 관리는 모델 독립적
4. **MCP 통합** — 3사 모두 MCP 지원 (연결 방식만 다름)
5. **메모리/컨텍스트 관리** — 에이전트 레벨에서 통합

---

## 5. 공통 필수 Tool 도출

3사 CLI 에이전트(Codex CLI, Claude Code, Gemini CLI)의 교차 비교를 기반으로 공통 필수 tool을 도출한다.

### 5.1 Tier 분류 기준

- **Tier 1 (필수)**: 3/3 에이전트가 모두 보유. 코딩 에이전트의 기본 기능.
- **Tier 2 (강력 권장)**: 2/3 이상 보유 + 실전에서 필수적.

### 5.2 Tier 1: 필수 구현 — 10개

| # | 기능 | OpenAI | Anthropic | Google | 통합 인터페이스 |
|---|------|--------|-----------|--------|--------------|
| **T1** | **File Read** | `read_file` | `Read` | `read_file` | `read_file(path, range?)` |
| **T2** | **File Write** | `apply_patch` (Add File) | `Write` | `write_file` | `write_file(path, content)` |
| **T3** | **File Edit** | `apply_patch` (Update File) | `Edit` | `replace` | `edit_file(path, ...)` ⚠️ |
| **T4** | **File Search** | (list_dir + grep_files) | `Glob` | `glob` | `glob(pattern, path?)` |
| **T5** | **Content Search** | `grep_files` | `Grep` | `grep_search` | `grep(pattern, opts?)` |
| **T6** | **Shell Exec** | `shell` / `shell_command` | `Bash` | `run_shell_command` | `shell(command, opts?)` |
| **T7** | **Web Search** | `web_search` | `WebSearch` | `google_web_search` | `web_search(query, opts?)` |
| **T8** | **Web Fetch** | (Responses API) | `WebFetch` | `web_fetch` | `web_fetch(url, prompt?)` |
| **T9** | **Task Tracking** | `update_plan` | `TaskCreate`+`TaskUpdate` | `write_todos` | `manage_tasks(...)` |
| **T10** | **Ask User** | `request_user_input` | `AskUserQuestion` | `ask_user` | `ask_user(questions)` |

### 5.3 Tier 2: 강력 권장 — 4개

| # | 기능 | OpenAI | Anthropic | Google | 비고 |
|---|------|--------|-----------|--------|------|
| **T11** | **Plan Mode** | `update_plan` (약한) | `EnterPlanMode`/`ExitPlanMode` | `enter_plan_mode`/`exit_plan_mode` | 2사 명시적 도구, 1사 암시적 |
| **T12** | **Sub-agent** | `spawn_agent`+4개 제어 | `Task` (단일) | 시스템 프롬프트 기반 | 2사 명시적 도구 |
| **T13** | **Tool Search** | `search_tool_bm25` | `ToolSearch` | 없음 | tool 수 증가 시 필수 |
| **T14** | **Skills** | 없음 (`AGENTS.md`로 대체) | `Skill` | `activate_skill` | 2사 명시적, 모듈 확장성 |

### 5.4 각 Tool별 설계 분석

#### T1. File Read — 합의도 높음

```
통합 인터페이스: read_file(path, start?, end?)
```

3사 거의 동일. 차이점은 부가기능:

| 부가기능 | OpenAI | Anthropic | Google | 채택 여부 |
|---------|--------|-----------|--------|----------|
| 라인 범위 | offset + limit | offset + limit | start_line + end_line | Yes (기본) |
| 멀티미디어 | 이미지 | 이미지, PDF, ipynb | 이미지, 오디오, PDF | Yes |
| indentation mode | **있음** (unique) | 없음 | 없음 | 고려 (코드 탐색에 유용) |
| 대량 읽기 | 없음 | 없음 | `read_many_files` | 별도 tool로 고려 |

결론: 기본 인터페이스는 3사 동일. 모델별 어댑터 불필요. **실행 레이어에서 통합 구현 가능.**

#### T2. File Write — 합의도 높음

```
통합 인터페이스: write_file(path, content)
```

3사 거의 동일. 주의할 차이:
- Anthropic: 기존 파일이면 Read 선행 강제 (안전장치)
- Google: 사용자가 content를 쓰기 전 수정 가능 (human-in-the-loop)
- OpenAI: `apply_patch`의 `*** Add File:` 로 통합됨

결론: 실행 레이어 통합 가능. Read-before-Write 안전장치는 오케스트레이션 레이어에서.

#### T3. File Edit — ⚠️ 가장 큰 분기점

```
통합 인터페이스: edit_file(path, changes)
  ↓ 모델별 어댑터가 변환
  - OpenAI  → V4A diff format (freeform)
  - Anthropic → str_replace (old→new)
  - Google  → str_replace + instruction
```

이것이 agent 설계의 핵심 결정. 3가지 접근법:

| 접근법 | 장점 | 단점 |
|--------|------|------|
| **A. 모델별 네이티브 포맷** | 성능 최대화 | 3벌 구현+테스트 |
| **B. str_replace 통일** | 구현 단순, 2/3 모델 네이티브 | OpenAI에서 성능 손실 |
| **C. 실행 레이어에서 변환** | 모델은 자유 포맷, 결과만 통일 | 변환 신뢰성 문제 |

권장: **B (str_replace 통일)** — Anthropic과 Google이 네이티브, OpenAI도 JSON fallback 지원. 실행 레이어는 하나로 통합하되, OpenAI 최적화가 필요한 경우에만 V4A 어댑터 추가.

#### T4. File Search (Glob) — 합의도 높음

```
통합 인터페이스: glob(pattern, path?)
```

| 기능 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| glob 패턴 | grep_files의 include | pattern 파라미터 | pattern 파라미터 |
| 무시 파일 | .gitignore | .gitignore | .gitignore + .geminiignore |
| 정렬 | 수정시간 순 | 수정시간 순 | 미명시 |

결론: 통합 구현 가능. `.agentignore` 같은 자체 무시 파일 고려.

#### T5. Content Search (Grep) — 합의도 높음

```
통합 인터페이스: grep(pattern, path?, include?, context?)
```

3사 모두 ripgrep 기반. 파라미터 약간 다르지만 실행 레이어 동일:

| 파라미터 | OpenAI | Anthropic | Google |
|---------|--------|-----------|--------|
| 패턴 | `pattern` (regex) | `pattern` (regex) | `pattern` (Rust regex) |
| 파일 필터 | `include` (glob) | `glob` / `type` | `include` / `exclude_pattern` |
| 컨텍스트 | 없음 | `-A`/`-B`/`-C` | `after`/`before`/`context` |
| 출력 모드 | files only | files/content/count | names_only + content |
| 결과 제한 | `limit` | `head_limit` | `max_matches_per_file` + `total_max_matches` |

결론: 실행 레이어 통합. 풍부한 옵션은 Anthropic/Google 참고.

#### T6. Shell Execution — 합의도 높음 (세부 차이)

```
통합 인터페이스: shell(command, workdir?, timeout?, background?)
```

| 기능 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| 커맨드 형식 | array 또는 string | string | string |
| 세션 유지 | 없음 (stateless) | **persistent session** | 없음 |
| 백그라운드 | PTY 세션 | `run_in_background` | `is_background` |
| description | 없음 | `description` | `description` |
| 플랫폼 인식 | Win variant 별도 | 없음 | Win/Unix 동적 |

결론: string 커맨드 방식으로 통합. persistent session은 옵션. `description` 파라미터는 UX에 유용하므로 채택.

#### T7. Web Search — 합의도 높음

```
통합 인터페이스: web_search(query, domain_filter?)
```

결론: 실행 레이어에서 검색 엔진 추상화. 도메인 필터링은 공통 지원.

#### T8. Web Fetch — 합의도 높음

```
통합 인터페이스: web_fetch(url, prompt?)
```

| 차이 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| URL 제한 | 없음 | 대화 내 URL만 | 없음 (localhost 허용) |
| 다중 URL | 미지원 | 미지원 | 최대 20개 |
| 처리 방식 | 직접 | AI 모델로 요약 | AI 모델로 분석 |

결론: 단일 URL + prompt 방식 기본, 다중 URL은 확장.

#### T9. Task Tracking — 합의도 중간 (방식 차이 큼)

```
통합 인터페이스: 두 가지 선택지
  A. write_tasks(tasks[])     — 전체 교체 (OpenAI, Google 방식)
  B. task_crud(action, ...)   — 개별 CRUD (Anthropic 방식)
```

| 방식 | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| 업데이트 | 전체 교체 | 개별 CRUD | 전체 교체 |
| 의존성 | 없음 | blocks/blockedBy | 없음 |
| 상태값 | 3종 | 4종 (deleted 포함) | 4종 (cancelled 포함) |

권장: **개별 CRUD (Anthropic 방식)** — 의존성 지원이 복잡한 태스크에 필수. 전체 교체는 간단하지만 확장성 부족.

#### T10. Ask User — 합의도 높음 (구조화 수준 차이)

```
통합 인터페이스: ask_user(questions[{question, type, options?}])
```

권장: Google의 구조화 수준 채택 (`choice`/`text`/`yesno` 타입 분화). Anthropic의 `markdown` 미리보기도 유용.

#### T11. Plan Mode — 2/3 명시적 지원

```
통합 인터페이스: enter_plan_mode(reason?) / exit_plan_mode(plan)
```

핵심 설계: plan mode에서 **읽기 전용 tool만 허용** (Anthropic, Google 공통)

| Plan Mode에서 허용되는 도구 | Anthropic | Google |
|---------------------------|-----------|--------|
| File Read | Yes | Yes |
| Glob/Grep | Yes | Yes |
| Web Search | 미확인 | Yes |
| Shell (읽기 명령) | 제한적 | 미허용 |
| Ask User | 미확인 | Yes |
| Edit/Write/Shell | **No** | **No** |

결론: 필수 구현. "읽기 전용 도구 제한"이 핵심 패턴.

#### T12. Sub-agent — 2/3 명시적 지원

```
통합 인터페이스: dispatch_agent(prompt, tools?, model_tier?)
```

| 모델 | 접근법 | 특징 |
|------|--------|------|
| OpenAI | 5개 제어 tool (spawn/send/resume/wait/close) | 세밀한 제어, 양방향 통신 |
| Anthropic | 단일 Task tool | 단방향 (prompt→result), 모델 계층화 |
| Google | 시스템 프롬프트 기반 | 명시적 tool 없음 |

권장: Anthropic 방식 (단일 dispatch + 모델 계층화) 기본, OpenAI 방식 (세밀한 제어)은 확장.

### 5.5 아키텍처 요약

```
┌─────────────────────────────────────────────────┐
│              필수 구현 (Tier 1) - 10개             │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ 파일 조작                                  │    │
│  │  T1. read_file    — 통합 가능             │    │
│  │  T2. write_file   — 통합 가능             │    │
│  │  T3. edit_file    — ⚠️ 모델별 어댑터 필요  │    │
│  │  T4. glob         — 통합 가능             │    │
│  │  T5. grep         — 통합 가능             │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ 실행 & 외부                                │    │
│  │  T6. shell        — 통합 가능             │    │
│  │  T7. web_search   — 통합 가능             │    │
│  │  T8. web_fetch    — 통합 가능             │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │ 에이전트 상태                               │    │
│  │  T9. task_mgmt    — 통합 가능             │    │
│  │  T10. ask_user    — 통합 가능             │    │
│  └──────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│           강력 권장 (Tier 2) - 4개               │
│  T11. plan_mode      — 통합 가능              │
│  T12. sub_agent      — 통합 가능              │
│  T13. tool_search    — 통합 가능              │
│  T14. skills         — 통합 가능              │
└─────────────────────────────────────────────────┘

⚠️ = 유일하게 모델별 어댑터가 필요한 tool
```

핵심 결론 (초기): 14개 tool 중 13개는 모델 독립적으로 통합 구현 가능하고, 오직 `edit_file`만 모델별 어댑터가 필요하다.

### 5.6 추가 리서치: edit_file 외에 모델별 어댑터가 필요한 영역

초기 결론("edit_file만 어댑터 필요")에 대한 심층 검증 결과, **edit_file 외에도 3개 영역에서 추가 어댑터가 필요**한 것으로 확인되었다.

상세 리서치: `research/tool-output-formats.md`, `research/agentic-prompting-patterns.md`

#### 수정된 어댑터 필요성 매트릭스

| 영역 | 어댑터 필요? | Tier | 핵심 차별점 | 성능 영향 |
|------|-----------|------|-----------|----------|
| **T3. File Edit** | **필수 (Hard)** | 1 | V4A diff vs str_replace vs instruction | 15-88% (Diff-XYZ 벤치마크) |
| **시스템 프롬프트** | **필수 (Hard)** | 1 | 3사 모두 다른 agentic 패턴 | ~20% (OpenAI SWE-bench) |
| **Tool Description** | **권장 (Soft)** | 1 | 모델별 최적화된 description text | ~2% (OpenAI) ~ SOTA 달성 (Anthropic) |
| **Web Search 결과** | **필수 (Hard)** | 1 | 서버사이드 tool, 인용 구조 완전히 다름 | 파싱 어댑터 필수 |
| **Shell 결과 포맷** | 유익 | 2 | 구조화 JSON vs 인라인 텍스트 | 낮음-중간 |
| **File Read 출력** | 유익 | 2 | `cat -n` vs 라인번호 없음 vs 플레인 | 후속 편집 정확도에 영향 |
| **Task/Plan 방식** | 선택 | 2 | 전체 교체 vs 개별 CRUD | 낮음 |
| Grep/검색 결과 | 불필요 | 3 | 보편적 ripgrep 출력 | 없음 |
| 병렬 호출 | 불필요 | 3 | 프롬프팅으로 해결 | 없음 |
| 에러 처리 | 불필요 | 3 | 보편적 error-as-content 패턴 | 없음 |
| 토큰 처리 | 불필요 | 3 | 설정값 차이일 뿐 | 없음 |

#### 추가 어댑터 #1: 시스템 프롬프트 (Hard Adapter)

3사의 agentic 패턴이 모두 다르며, 교차 적용 시 성능 저하가 발생한다:

- **OpenAI**: 3대 핵심 지시 (persistence + tool-calling + planning) → ~20% 벤치마크 향상. GPT-5는 GPT-4.1과 다른 튜닝 필요 ("Be THOROUGH"가 GPT-5에서는 역효과).
- **Anthropic**: 간결함 지시 + XML 태그 구조화 + 세부 tool 라우팅 규칙. Claude 4.6는 이전 모델과 다르게 과도한 탐색을 억제해야 함.
- **Google**: Research→Strategy→Execution 라이프사이클 + "Explain Before Acting" + 컨텍스트 효율 명시. Gemini 3는 temperature 1.0 유지 필수.

**PromptBridge 논문 (2025.12)** 결과: 모델 간 프롬프트 이전 시 **30+ 포인트 성능 하락** 확인.

권장 아키텍처 — 시스템 프롬프트 3계층:
```
Layer 1: Universal Core (~70%) — persistence, tool-over-guessing, safety, planning
Layer 2: Harness-Specific (~20%) — tool descriptions, edit format, 경로 규칙
Layer 3: Model-Specific (~10%) — eagerness 조절, 지시 강도, 추론 설정
```

~80%는 보편적이지만, 나머지 ~20%의 모델별 보정이 5-15% 성능 차이를 만든다.

#### 추가 어댑터 #2: Tool Description Text (Soft Adapter)

**BFCL V4 (Berkeley Function-Calling Leaderboard)** 연구 결과:
- JSON tool 정의가 XML/Python보다 **일관되게** 높은 성능 (39개 모델, 26개 변형 테스트)
- Claude-3.7-Sonnet: XML return format에서 **유의미한 성능 하락**
- 전문 tool-calling 모델: 학습 분포 외 포맷에서 **거의 0% 정확도**

3사의 근거:
- **OpenAI**: tools API 필드 사용이 프롬프트 삽입보다 SWE-bench에서 **2% 높음**
- **Anthropic**: tool description 미세 조정만으로 SWE-bench Verified **SOTA 달성**
- **Google**: 모델 세대별 다른 description set 유지 (legacy vs gemini-3)

단, "tool description 구조(JSON/XML)가 중요하지, 자연어 표현 차이는 미미하다" (BFCL V4).

#### 추가 어댑터 #3: Web Search 결과 파싱 (Hard Adapter)

서버사이드 tool이므로 출력 포맷을 제어할 수 없다. 각 API의 인용 구조:

| | OpenAI | Anthropic | Google |
|--|--------|-----------|--------|
| **인용 형식** | `url_citation` (문자 위치 기반) | `web_search_result_location` (블록 인덱스 기반) | `groundingMetadata` (바이트 위치 기반) |
| **소스 매핑** | `start_index`/`end_index` | `start_block_index`/`end_block_index` | `startIndex`/`endIndex` + `groundingChunkIndices` |
| **암호화** | 없음 | `encrypted_content` (멀티턴용) | 없음 |

통합 UI를 위해서는 각 API의 인용 구조를 통합 표현으로 변환하는 파서가 필요.

#### 추가 발견: File Read 출력 포맷의 숨은 영향

| CLI | 파일 내용 출력 포맷 | 라인 번호 |
|-----|-----------------|----------|
| **Claude Code** | `cat -n` 형식 (`  1⇥def foo():`) | 있음, 탭 구분 |
| **Codex CLI** | 평문 (셸 명령 결과) | 없음 |
| **Gemini CLI** | 평문 문자열 | 없음 |

- Claude는 `cat -n` 포맷에 학습되어 있어, 이 포맷으로 파일을 보여줘야 후속 str_replace 정확도가 높음
- GPT는 라인 번호 없이 컨텍스트 기반으로 위치를 특정 (V4A 방식과 일치)
- **Diff-XYZ 논문 (NeurIPS 2025 Workshop)**: diff 포맷 선택이 동일 모델에서 **15-88% 성능 차이** 유발

이는 edit_file 어댑터와 연동되는 문제 — 편집 방식이 str_replace면 라인 번호 포함 출력이 유리하고, V4A diff면 라인 번호 없는 출력이 유리.

#### 수정된 아키텍처 요약

```
┌──────────────────────────────────────────────────────┐
│                 Model Adapter Layer                    │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Hard Adapters (필수, 성능에 직접 영향)             │ │
│  │  1. EditAdapter      — V4A / str_replace / +instr│ │
│  │  2. SystemPromptAdapter — 3계층 프롬프트 생성      │ │
│  │  3. WebSearchAdapter — 인용 구조 파싱              │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ Soft Adapters (권장, 최적화에 영향)               │ │
│  │  4. ToolDescriptionAdapter — 모델별 description  │ │
│  │  5. FileReadFormatAdapter — 라인번호 포맷        │ │
│  │  6. ShellResultAdapter — 결과 구조화 수준         │ │
│  └─────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│              Universal Tool Layer (모델 독립)          │
│  glob, grep, task_mgmt, ask_user, plan_mode,         │
│  sub_agent, tool_search, skills                      │
└──────────────────────────────────────────────────────┘
```

**수정된 핵심 결론**: "edit_file만 어댑터 필요"는 불충분. **Hard Adapter 3개 + Soft Adapter 3개 = 총 6개 어댑터 영역**이 모델별 처리가 필요하다. 특히 시스템 프롬프트 어댑터는 edit만큼이나 성능에 중요하다.

---

## 7. 각사별 고유 혁신 요약

### OpenAI만의 것
- **Freeform tools with Lark grammar** — JSON 대안, 대형 텍스트 출력에 최적
- **V4A diff format** — 모델-포맷 공진의 정수
- **PTY 인터랙티브 세션** — 대화형 프로세스 제어
- **Indentation-aware file reading** — 코드 블록 시맨틱 확장
- **Reasoning persistence** (`previous_response_id`) — 멀티턴 추론 연속성

### Anthropic만의 것
- **Schema-less built-in tools** — 모델 가중치에 내장된 tool 스키마
- **Model stratification** (Haiku/Sonnet/Opus) — 비용 최적화된 서브에이전트
- **Programmatic tool calling** — 코드 실행 내에서 tool 호출 (37% 토큰 절약)
- **Tool use examples** (`input_examples`) — 72%→90% 정확도 향상
- **Agent Skills open standard** (agentskills.io) — 크로스 에이전트 스킬 공유

### Google만의 것
- **`instruction` parameter on edits** — 변경 의도의 시맨틱 기록 + LLM 기반 보정
- **Model-family tool descriptions** — 모델 세대별 최적화된 tool 설명
- **Thought signatures** — Gemini 3의 추론 과정과 function calling 통합
- **Compositional function calling** — 모델 내부 tool 체이닝 (라운드트립 감소)
- **Google Maps grounding** — 위치 기반 AI 응답
- **`.geminiignore`** — 에이전트 전용 무시 파일

---

## 8. Sources

### 상세 조사 문서
- [OpenAI Tools 상세 조사](./openai-tools.md)
- [Anthropic Tools 상세 조사](./anthropic-tools.md)
- [Google Gemini Tools 상세 조사](./gemini-tools.md)

### 추가 리서치 문서
- [Tool Output Format 영향 분석](../tool-output-formats.md)
- [Agentic Prompting 패턴 이전성 분석](../agentic-prompting-patterns.md)

### 주요 참고 자료
- [OpenAI Codex CLI](https://github.com/openai/codex)
- [OpenAI Apply Patch Guide](https://platform.openai.com/docs/guides/tools-apply-patch)
- [GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)
- [Anthropic Tool Use Docs](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [Anthropic Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/sdk)
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Google Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Google ADK](https://google.github.io/adk-docs/)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)

### 추가 리서치 참고 자료
- [BFCL V4 Format Sensitivity Study (Berkeley)](https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html)
- [Diff-XYZ Benchmark (NeurIPS 2025 Workshop)](https://arxiv.org/abs/2510.12487)
- [Anthropic: Writing Effective Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic: Context Engineering for Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
