# Google Gemini Ecosystem: LLM-Native Tools Research

**Date:** 2026-02-24
**Scope:** Gemini CLI, Gemini API built-in tools, Google ADK, Jules, function calling specifics
**Sources:** GitHub repository analysis, official documentation, web research

---

## Table of Contents

1. [Gemini CLI Tools (from GitHub source)](#1-gemini-cli-tools)
2. [Gemini API Built-in Tools](#2-gemini-api-built-in-tools)
3. [Google ADK (Agent Development Kit)](#3-google-adk)
4. [Jules AI Coding Agent](#4-jules-ai-coding-agent)
5. [Function Calling Specifics](#5-function-calling-specifics)
6. [Cross-Cutting Analysis](#6-cross-cutting-analysis)

---

## 1. Gemini CLI Tools

**Repository:** `google-gemini/gemini-cli` (Apache 2.0, TypeScript monorepo)
**Architecture:** Monorepo with packages: `cli`, `core`, `sdk`, `devtools`, `a2a-server`, `vscode-ide-companion`

### 1.1 Complete Tool Inventory (17 tools)

Extracted from `/packages/core/src/tools/definitions/base-declarations.ts` and tool implementation files:

| # | Tool Name | Internal Constant | Category |
|---|-----------|-------------------|----------|
| 1 | `read_file` | READ_FILE_TOOL_NAME | File I/O |
| 2 | `write_file` | WRITE_FILE_TOOL_NAME | File I/O |
| 3 | `read_many_files` | READ_MANY_FILES_TOOL_NAME | File I/O |
| 4 | `replace` | EDIT_TOOL_NAME | File Editing |
| 5 | `glob` | GLOB_TOOL_NAME | File Search |
| 6 | `grep_search` | GREP_TOOL_NAME | Content Search |
| 7 | `list_directory` | LS_TOOL_NAME | File Navigation |
| 8 | `run_shell_command` | SHELL_TOOL_NAME | Shell |
| 9 | `google_web_search` | WEB_SEARCH_TOOL_NAME | Web |
| 10 | `web_fetch` | WEB_FETCH_TOOL_NAME | Web |
| 11 | `write_todos` | WRITE_TODOS_TOOL_NAME | Task Management |
| 12 | `save_memory` | MEMORY_TOOL_NAME | Memory |
| 13 | `get_internal_docs` | GET_INTERNAL_DOCS_TOOL_NAME | Self-Knowledge |
| 14 | `activate_skill` | ACTIVATE_SKILL_TOOL_NAME | Skills |
| 15 | `ask_user` | ASK_USER_TOOL_NAME | User Interaction |
| 16 | `enter_plan_mode` | ENTER_PLAN_MODE_TOOL_NAME | Planning |
| 17 | `exit_plan_mode` | EXIT_PLAN_MODE_TOOL_NAME | Planning |

**Plan Mode** restricts to read-only tools: `glob`, `grep_search`, `read_file`, `list_directory`, `google_web_search`, `ask_user`, `activate_skill`, `exit_plan_mode`.

### 1.2 Model-Family Tool Sets

Gemini CLI maintains **two distinct tool definition sets** that can be swapped based on model:
- `default-legacy` -- for older Gemini models
- `gemini-3` -- for Gemini 3 series with optimized descriptions

Key differences in the Gemini 3 set:
- `write_file`: Shorter description, explicitly notes "use 'replace' for targeted edits to large files"
- `google_web_search`: Enhanced description mentioning grounded search with citations and follow-up with `web_fetch`
- `web_fetch`: Better description noting GitHub blob URL auto-conversion
- `save_memory`: More precise about global vs workspace-specific scope
- `grep_search_ripgrep`: Notes it is "FAST and optimized, powered by ripgrep. PREFERRED over standard `run_shell_command("grep ...")`"

This model-family architecture allows tool descriptions to be co-evolved with specific model capabilities.

### 1.3 Detailed Tool Schemas

#### read_file
```json
{
  "name": "read_file",
  "description": "Reads and returns the content of a specified file. If the file is large, the content will be truncated...",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The path to the file to read." },
      "start_line": { "type": "number", "description": "Optional: The 1-based line number to start reading from." },
      "end_line": { "type": "number", "description": "Optional: The 1-based line number to end reading at (inclusive)." }
    },
    "required": ["file_path"]
  }
}
```
Supports: text, images (PNG, JPG, GIF, WEBP, SVG, BMP), audio (MP3, WAV, AIFF, AAC, OGG, FLAC), PDFs.

#### write_file
```json
{
  "name": "write_file",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string" },
      "content": { "type": "string", "description": "Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide complete literal content." }
    },
    "required": ["file_path", "content"]
  }
}
```
Notable: "The user has the ability to modify `content`" -- signals human-in-the-loop modification before write.

#### replace (Edit Tool)
```json
{
  "name": "replace",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string" },
      "instruction": { "type": "string", "description": "A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change." },
      "old_string": { "type": "string", "description": "The exact literal text to replace, unescaped." },
      "new_string": { "type": "string", "description": "The exact literal text to replace old_string with, unescaped." },
      "allow_multiple": { "type": "boolean", "description": "If true, replace all occurrences." }
    },
    "required": ["file_path", "instruction", "old_string", "new_string"]
  }
}
```
**Design choice:** Requires an `instruction` parameter -- a semantic description of the change's purpose. This is unique among coding agents. The `instruction` serves as a "high-quality prompt for an expert LLM assistant" to understand WHY/WHERE/WHAT/OUTCOME. This could be used for:
- Human-readable change logs
- LLM-based edit correction (the codebase includes `llm-edit-fixer.ts` and `editCorrector.ts`)
- Backup editing if old_string matching fails

#### grep_search (ripgrep variant)
```json
{
  "name": "grep_search",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Rust-flavored regex. Use '\\b' for precise matching." },
      "dir_path": { "type": "string" },
      "include": { "type": "string", "description": "Glob pattern to filter files" },
      "exclude_pattern": { "type": "string" },
      "names_only": { "type": "boolean" },
      "case_sensitive": { "type": "boolean" },
      "fixed_strings": { "type": "boolean" },
      "context": { "type": "integer" },
      "after": { "type": "integer", "minimum": 0 },
      "before": { "type": "integer", "minimum": 0 },
      "no_ignore": { "type": "boolean" },
      "max_matches_per_file": { "type": "integer", "minimum": 1 },
      "total_max_matches": { "type": "integer", "minimum": 1 }
    },
    "required": ["pattern"]
  }
}
```

#### run_shell_command
```json
{
  "name": "run_shell_command",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "Exact bash command to execute as `bash -c <command>`" },
      "description": { "type": "string", "description": "Brief description of the command for the user. Be specific and concise." },
      "dir_path": { "type": "string", "description": "The path of the directory to run the command in." },
      "is_background": { "type": "boolean", "description": "Set to true for background commands." }
    },
    "required": ["command"]
  }
}
```
Platform-aware: generates Windows (PowerShell) vs Unix (bash) descriptions dynamically.
Returns: Output, Exit Code (if non-zero), Error, Signal, Background PIDs, Process Group PGID.

#### google_web_search
```json
{
  "name": "google_web_search",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "The search query. Supports natural language questions." }
    },
    "required": ["query"]
  }
}
```
Gemini 3 version: "Performs a grounded Google Search... Returns a synthesized answer with citations ([1]) and source URIs." Explicitly tells model to follow up with `web_fetch` for deeper analysis.

#### web_fetch
```json
{
  "name": "web_fetch",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "A string containing the URL(s) and specific analysis instructions. Supports up to 20 URLs." }
    },
    "required": ["prompt"]
  }
}
```
Supports localhost and private network addresses. GitHub blob URLs auto-converted to raw.

#### ask_user
```json
{
  "name": "ask_user",
  "parametersJsonSchema": {
    "type": "object",
    "required": ["questions"],
    "properties": {
      "questions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "items": {
          "type": "object",
          "required": ["question", "header", "type"],
          "properties": {
            "question": { "type": "string" },
            "header": { "type": "string", "description": "Very short label as chip/tag." },
            "type": { "type": "string", "enum": ["choice", "text", "yesno"] },
            "options": { "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string" }, "description": { "type": "string" } } } },
            "multiSelect": { "type": "boolean" },
            "placeholder": { "type": "string" }
          }
        }
      }
    }
  }
}
```
**Rich structured user interaction** -- supports multiple question types with options, multi-select, and placeholders. This is significantly more structured than Claude Code's simple text input.

#### write_todos
```json
{
  "name": "write_todos",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "todos": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "description": { "type": "string" },
            "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }
          },
          "required": ["description", "status"]
        }
      }
    },
    "required": ["todos"]
  }
}
```
Replaces entire todo list each call. States: pending, in_progress, completed, cancelled. Includes extensive examples in description of when to use vs. not use.

#### save_memory
```json
{
  "name": "save_memory",
  "parametersJsonSchema": {
    "type": "object",
    "properties": {
      "fact": { "type": "string", "description": "A concise, global fact or preference." }
    },
    "required": ["fact"]
  }
}
```
**CRITICAL design rule:** GLOBAL context only. Never save workspace-specific paths, commands, or local info. Persists across all future sessions and workspaces.

#### Other tools
- **glob**: Pattern matching with `respect_git_ignore` and `respect_gemini_ignore` options
- **list_directory**: With `file_filtering_options` for .gitignore/.geminiignore
- **read_many_files**: Bulk read via glob patterns, supports images/audio/PDF alongside text
- **get_internal_docs**: Self-knowledge retrieval for Gemini CLI documentation
- **activate_skill**: Dynamic skill activation with enum-constrained names
- **enter_plan_mode**: Switches to read-only research mode with reason parameter
- **exit_plan_mode**: Finalizes plan with `plan_path` parameter pointing to plans directory

### 1.4 System Prompt Architecture

The system prompt is composed from modular snippets:
- **Preamble**: Interactive vs autonomous mode
- **Core Mandates**: Security, context efficiency, engineering standards
- **Sub-Agents**: XML-based sub-agent delegation
- **Agent Skills**: XML-based skill listing with `activate_skill` tool
- **Hook Context**: External hook data handling
- **Primary Workflows**: Research -> Strategy -> Execution lifecycle
- **Operational Guidelines**: Tone, style, formatting
- **Sandbox**: macOS seatbelt, generic, or outside
- **Git Repo**: Git-specific instructions

Key system prompt patterns:
- **Context Efficiency**: Explicit guidance to minimize unnecessary context usage, combine parallel operations, prefer grep over individual file reads
- **Research -> Strategy -> Execution** lifecycle with Plan -> Act -> Validate inner loop
- **Explain Before Acting**: Must provide one-sentence explanation before tool calls
- **Inquiries vs Directives**: Distinguishes analysis requests from action requests

### 1.5 MCP Integration

MCP tool naming: `server__tool` format (double underscore separator).
Full MCP client implementation with `mcp-client-manager.ts` and `mcp-tool.ts`.

### 1.6 Comparison to Claude Code

| Feature | Gemini CLI | Claude Code |
|---------|-----------|-------------|
| Edit tool | `replace` (search-replace + instruction) | `Edit` (old_string/new_string) |
| Edit instruction | Required `instruction` parameter | Not required |
| User interaction | Structured `ask_user` with question types | Simple text input |
| Todo/tasks | `write_todos` (replaces entire list) | `TaskCreate`/`TaskUpdate` (individual) |
| Memory | `save_memory` (global facts) | Not built-in (uses CLAUDE.md) |
| Web search | `google_web_search` (grounded) | `WebSearch` |
| Web fetch | `web_fetch` (URL + prompt combined) | `WebFetch` (URL + prompt separate) |
| Self-docs | `get_internal_docs` | Not present |
| Plan mode | `enter_plan_mode`/`exit_plan_mode` | Not explicit tools |
| Skills | `activate_skill` | `Skill` |
| Model-family schemas | Yes (legacy vs gemini-3) | No (single schema set) |
| Bulk file read | `read_many_files` | Not present |
| Background commands | `is_background` parameter | `run_in_background` parameter |

---

## 2. Gemini API Built-in Tools

The Gemini API provides **6 managed built-in tools** that execute entirely within one API call on Google's servers:

### 2.1 Google Search (Grounding)

**Purpose:** Ground responses in current web data, reduce hallucinations.
**Configuration:**
```python
types.Tool(google_search=types.GoogleSearch())
```
```json
{ "tools": [{ "googleSearch": {} }] }
```

**How it works (5-step workflow):**
1. User sends prompt with `google_search` enabled
2. Model analyzes prompt to determine if search helps
3. Model auto-generates and executes search queries
4. Model synthesizes search results into response
5. Returns grounded response with `groundingMetadata`

**Response metadata:**
- `webSearchQueries`: Array of search queries used (useful for debugging)
- `searchEntryPoint`: HTML/CSS for required Search Suggestions widget
- `groundingChunks`: Web sources with `uri` and `title`
- `groundingSupports`: Links text segments to sources via `startIndex`, `endIndex`, `groundingChunkIndices`

**Billing:** Per search query the model executes (multiple queries per request counted separately).

### 2.2 Code Execution

**Purpose:** Execute Python code for mathematical/data processing tasks.
**Configuration:**
```python
types.Tool(code_execution=types.ToolCodeExecution)
```

**Response parts:**
1. `text` -- explanatory text
2. `executable_code` -- Python code with `code` property
3. `code_execution_result` -- output with `output` property

**Constraints:**
- Python only (can generate other languages but only executes Python)
- 30-second max execution time
- Up to 5 retries on errors
- No custom library installation
- Pre-installed: numpy, pandas, matplotlib, scikit-learn, scipy, tensorflow, pillow, opencv-python, sympy, etc.

**Cost:** No additional charge beyond standard token billing.

### 2.3 URL Context

**Purpose:** Read and analyze content from specific web pages.
**Configuration:**
```json
{ "tools": [{ "url_context": {} }] }
```

**How it works:**
1. Attempts retrieval from internal index cache (fast/cheap)
2. Falls back to live fetch for uncached URLs

**Constraints:**
- Max 20 URLs per request
- Max 34MB per URL
- Must be publicly accessible
- Supports: HTML, JSON, text, XML, CSS, JS, CSV, RTF, PNG, JPEG, WebP, PDFs
- Does NOT support: paywalled content, YouTube, Google Workspace, video/audio

**Response metadata:** `url_context_metadata` with retrieval status per URL.

### 2.4 Google Maps (Grounding)

**Purpose:** Ground responses in Google Maps location data (250M+ places).
**Configuration:**
```python
types.Tool(google_maps=types.GoogleMaps(
    enable_widget=True  # optional
))
```
With location context:
```python
types.GoogleMaps(
    location=types.LatLng(latitude=35.6, longitude=139.7)
)
```

**Response:** `groundingMetadata` with Maps sources, optional `google_maps_widget_context_token`.
**GA:** October 17, 2025.

### 2.5 Computer Use

**Purpose:** Automate browser/UI interactions via screenshot analysis.
**Configuration:**
```python
types.Tool(computer_use=types.ComputerUse(
    environment=types.Environment.ENVIRONMENT_BROWSER,
    excluded_predefined_functions=["drag_and_drop"]  # optional
))
```

**Action types (normalized 1000x1000 coordinate grid):**

| Action | Key Parameters |
|--------|---------------|
| `click_at` | x, y |
| `type_text_at` | x, y, text, press_enter, clear_before_typing |
| `scroll_at` | x, y, direction, magnitude |
| `scroll_document` | direction |
| `navigate` | url |
| `drag_and_drop` | x, y, destination_x, destination_y |
| `hover_at` | x, y |
| `key_combination` | keys (e.g. "Control+C") |
| `go_back` / `go_forward` | none |
| `wait_5_seconds` | none |

**Safety decisions:** Responses include `safety_decision` field: `"regular"` (allowed) or `"require_confirmation"` (needs user approval).

**Models:** gemini-2.5-computer-use-preview, gemini-3-pro-preview, gemini-3-flash-preview (built-in for Gemini 3).

### 2.6 File Search (Built-in RAG)

**Purpose:** Fully managed RAG -- index documents for semantic retrieval.
**Released:** November 2025.
**Configuration:**
```python
# Create store
store = client.file_search_stores.create(config={'display_name': 'my-store'})

# Upload files
client.file_search_stores.upload_to_file_search_store(
    file='doc.pdf',
    file_search_store_name=store.name
)

# Use in generation
response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents="question here",
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            file_search=types.FileSearch(
                file_search_store_names=[store.name]
            )
        )]
    )
)
```

**Capabilities:**
- Automatic chunking, embedding, indexing
- Custom chunking config (max_tokens_per_chunk, max_overlap_tokens)
- Metadata filtering (`metadata_filter="author=Robert Graves"`)
- Custom metadata on documents
- 150+ file formats
- Max 100MB per document
- Storage persists indefinitely (unlike Files API 48h limit)
- Structured output integration

**Pricing:** $0.15/1M tokens for indexing; storage and query-time embeddings free.

### 2.7 Tool Compatibility Matrix

| Tool | Can combine with |
|------|-----------------|
| Google Search | Code Execution, URL Context, Google Maps |
| Code Execution | Google Search, URL Context |
| URL Context | Google Search, Code Execution |
| Google Maps | Google Search |
| Computer Use | Limited (separate models) |
| File Search | NOT compatible with other tools |

---

## 3. Google ADK (Agent Development Kit)

**Repository:** `google/adk-python` (Python), also TypeScript, Go, Java
**Purpose:** Open-source framework for building and deploying AI agents

### 3.1 Tool Categories

1. **Function Tools** -- developer-created custom tools
2. **Built-in Tools** -- Google Search, Code Execution, RAG
3. **Third-Party Tools** -- LangChain, LlamaIndex, MCP integrations

### 3.2 Function Tool Definition

**Python:**
```python
from google.adk.tools import FunctionTool

def get_weather(city: str) -> dict:
    """Retrieves current weather for a city."""
    return {"status": "success", "report": "Sunny, 22C"}

weather_tool = FunctionTool(func=get_weather)
```

**TypeScript:**
```typescript
import { FunctionTool } from "@google/adk";
import { z } from "zod";

const weatherTool = new FunctionTool({
    name: "get_weather",
    description: "Retrieves current weather for a city.",
    parameters: z.object({ city: z.string().describe("City name") }),
    execute: (params) => ({ status: "success" })
});
```

**Go:**
```go
weatherTool, err := functiontool.New(
    functiontool.Config{
        Name: "get_weather",
        Description: "Retrieves current weather",
    },
    getWeatherFunc,
)
```

### 3.3 ToolContext (Special ADK Feature)

`ToolContext` provides tools with access to agent runtime state:

| Attribute | Purpose |
|-----------|---------|
| `state` | Read/write session state with prefixes (app:, user:, session-specific) |
| `actions.transfer_to_agent` | Transfer control to another agent |
| `actions.skip_summarization` | Bypass LLM summarization of tool output |
| `actions.escalate` | Escalate to human/parent agent |
| `function_call_id` | Unique invocation identifier |
| `auth_response` | Authentication credentials |
| `load_artifact()` / `save_artifact()` | Manage file artifacts |
| `search_memory()` | Query long-term memory |

**Key design choices:**
- `skip_summarization`: When True, tool output goes directly to user without LLM post-processing
- `transfer_to_agent`: Enables dynamic agent handoff from within tool execution
- ToolContext should NOT be documented in docstrings (LLM doesn't need to know about it)

### 3.4 Built-in Tools in ADK

| Tool | Class | Description |
|------|-------|-------------|
| Google Search | `google_search` | Web search with Gemini grounding |
| Code Execution | `built_in_code_execution` | Execute AI-generated code |
| Code Execution (Vertex) | Uses Vertex AI sandbox | Secure GKE environment |
| Computer Use | `computer_use` | UI automation with Gemini |
| Vertex AI Search | RAG via Vertex AI | Enterprise search |

### 3.5 Toolsets (Dynamic Tool Grouping)

ADK supports `BaseToolset` interface for dynamic tool provision:
- Conditionally provide tools based on context
- Group tools by permission or capability
- Runtime tool discovery and registration

### 3.6 Integration Catalog

ADK provides pre-built integrations for:
- **Code:** GitHub, GitLab, Postman
- **Data:** BigQuery, MongoDB, Pinecone, Qdrant
- **Google Cloud:** Vertex AI, Cloud Trace, Pub/Sub
- **Observability:** AgentOps, Arize AX, Phoenix, MLflow
- **MCP:** Model Context Protocol servers
- **Search:** Google Search, Vertex AI Search

---

## 4. Jules AI Coding Agent

**Product:** Autonomous asynchronous coding agent by Google Labs
**Model:** Gemini 3 Pro (previously 2.5 Pro)
**Architecture:** Multi-agent with perceive-plan-execute-evaluate loop

### 4.1 Execution Model

- Runs asynchronously in cloud VMs (Ubuntu Linux)
- Tasks can span hours or days
- 2M token context window
- User can close computer and return later
- Preinstalled: Node.js, Bun, Python, Go, Java, Rust

### 4.2 Agent Architecture

**Multi-agent components:**
1. **Planning Agent** -- analyzes requirements, creates step-by-step roadmap
2. **Execution Agent** -- runs shell commands, modifies code, applies Git diffs
3. **Critique Agent** -- internal peer reviewer that questions code before completion
4. **Verification Agent** -- tests changes, validates output

**Loop:** Perceive -> Plan -> Execute -> Evaluate (iterative)

### 4.3 Known Internal Tools

From API activity logs and documentation:
- **Shell execution** -- runs bash commands in sandbox VM
- **Code modification** -- applies Git patches/unified diffs
- **Web search** -- proactively searches for documentation and examples
- **Test execution** -- runs project tests for validation
- **`frontend_verification_instructions`** -- generates Playwright verification scripts
- **Plan management** -- creates titled steps with execution indices

### 4.4 API Structure

**Base URL:** `https://jules.googleapis.com/v1alpha/`
**Key endpoints:**
- `POST /sessions` -- create work session with prompt and source context
- `POST /sessions/{id}:approvePlan` -- approve execution plan
- `GET /sessions/{id}/activities` -- list work activities
- `POST /sessions/{id}:sendMessage` -- send follow-up messages

**Automation modes:**
- `AUTO_CREATE_PR` -- automatically creates pull request on completion
- `requirePlanApproval` -- requires explicit plan approval before execution

### 4.5 CLI (Jules Tools)

Installed via npm. Provides:
- Commands: `jules remote list --task`, etc.
- TUI mode: Interactive dashboard
- Composable with GitHub CLI, Gemini CLI, jq

---

## 5. Function Calling Specifics

### 5.1 Function Declaration Schema

Uses a **subset of OpenAPI 3.0.3** schema:
```json
{
  "name": "function_name",
  "description": "Clear explanation of purpose",
  "parameters": {
    "type": "object",
    "properties": {
      "param_name": {
        "type": "string|integer|boolean|array|object",
        "description": "Parameter purpose and format",
        "enum": ["optional_fixed_values"]
      }
    },
    "required": ["mandatory_params"]
  }
}
```

### 5.2 Tool Config Modes

| Mode | Behavior |
|------|----------|
| **AUTO** (default) | Model decides: natural language OR function call |
| **ANY** | Model MUST predict a function call; guarantees schema adherence |
| **NONE** | Model prohibited from function calls |
| **VALIDATED** (preview) | Model can predict either, but guarantees schema adherence when calling |

**`allowed_function_names`**: Array restricting which functions model can call (used with ANY/VALIDATED).

### 5.3 Parallel Function Calling

- Model can return multiple function calls in a single turn
- Results mapped back via `tool_use_id` matching `call_id`
- Results can be returned in any order (async execution supported)
- No ordering dependency required for result submission

### 5.4 Compositional Function Calling

- Model chains multiple function calls sequentially
- Output from one function feeds as input to the next
- Model manages the orchestration internally

### 5.5 Thought Signatures (Gemini 3 Specific)

**Critical requirement for Gemini 3 models:**
- Gemini 3 uses internal "thinking" process for reasoning
- First `functionCall` part in each step must include `thought_signature`
- Omitting thought_signature causes 400 error
- For parallel calls in single response: only first functionCall has thought_signature
- For sequential calls across steps: each functionCall has thought_signature
- Official SDKs handle this automatically
- Manual API implementations must explicitly manage signatures

### 5.6 Function Response Format

```json
{
  "functionResponse": {
    "name": "function_name",
    "response": { "result": "data" }
  }
}
```

Gemini 3 series supports multimodal `parts` in function responses (images, etc.).

### 5.7 Automatic Function Calling (Python SDK)

The Python SDK supports automatic function execution:
```python
# Enabled by default -- SDK auto-executes functions
response = client.models.generate_content(...)

# Disable for manual control
config = types.GenerateContentConfig(
    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True)
)
```

### 5.8 Comparison: Gemini vs OpenAI vs Anthropic

| Feature | Gemini | OpenAI | Anthropic |
|---------|--------|--------|-----------|
| Schema format | OpenAPI 3.0.3 subset | JSON Schema (strict mode) | JSON Schema |
| Modes | AUTO/ANY/NONE/VALIDATED | auto/required/none | auto/any/tool |
| Parallel calls | Yes (tool_use_id mapping) | Yes (tool_call_id mapping) | Yes (tool_use_id) |
| Compositional chaining | Yes (built-in) | No (manual) | No (manual) |
| Thought signatures | Yes (Gemini 3) | No | No |
| Server-side execution | Yes (built-in tools) | Yes (code_interpreter, etc.) | No (MCP only) |
| Auto-execution SDK | Yes (Python) | No | No |
| Schema validation | Silently ignores invalid constraints | Throws error | Handles gracefully |
| Structured output + tools | Yes (VALIDATED mode) | Yes (strict mode) | Via tool_use |

---

## 6. Cross-Cutting Analysis

### 6.1 Design Philosophy

**Google's tool philosophy is "server-side managed execution":**
- Built-in tools (Search, Code Execution, Maps, File Search) execute entirely on Google's servers
- The model requests + executes + returns in a single API call
- No client-side orchestration needed for built-in tools
- Custom tools (function calling) follow the standard request-execute-return pattern

**This contrasts with:**
- **Anthropic**: No server-side tool execution; all tools are client-side (MCP)
- **OpenAI**: Hybrid -- some server-side (code_interpreter, file_search) + client function calling

### 6.2 Co-Evolution Patterns

1. **Model-family tool definitions** in Gemini CLI: Different description sets for different model generations
2. **Thought signatures**: Gemini 3's reasoning process is deeply integrated with function calling
3. **Grounding metadata**: The model doesn't just call tools -- it returns structured provenance (citations, source links, confidence)
4. **VALIDATED mode**: Server-side schema enforcement during tool calling
5. **Compositional function calling**: Model can chain tools internally without client orchestration

### 6.3 Unique Google Innovations

1. **`instruction` parameter on edit tool**: Semantic description of WHY a change is being made, enabling LLM-based edit correction
2. **Structured `ask_user` tool**: Rich question types (choice, text, yesno) with options and multi-select
3. **`save_memory` with strict global scope**: Memory tool explicitly designed for cross-workspace persistence
4. **`get_internal_docs`**: Self-knowledge tool for retrieving agent's own documentation
5. **`enter_plan_mode`/`exit_plan_mode`**: Explicit mode-switching tools that restrict available tools
6. **Google Maps grounding**: Location-aware AI responses with 250M+ places data
7. **File Search**: Fully managed RAG with automatic chunking/embedding -- no vector DB needed
8. **Computer Use safety decisions**: Built-in `require_confirmation` mechanism

### 6.4 Implications for Our Design

| Google Pattern | Relevance |
|---------------|-----------|
| Model-family tool sets | We should consider model-aware tool descriptions |
| `instruction` on edits | Excellent for audit trails and LLM-based edit recovery |
| Structured user interaction | Rich `ask_user` > simple text prompts |
| Explicit plan mode | Clear phase separation with tool restrictions |
| Context efficiency mandates | System prompt should guide efficient tool usage |
| Server-side built-in tools | We're client-side, but can pre-integrate common capabilities |
| Thought signatures | Unique to Gemini; our multi-model approach needs to handle protocol differences |
| Compositional function calling | Reduces round trips; consider if our architecture can leverage this |
| `.geminiignore` | Agent-specific ignore file (vs .gitignore) -- we should consider this |

### 6.5 Tool Count Comparison

| Agent | Built-in Tools | Categories |
|-------|---------------|------------|
| **Gemini CLI** | 17 | File I/O (3), Edit (1), Search (2), Nav (1), Shell (1), Web (2), Tasks (1), Memory (1), Self-docs (1), Skills (1), User (1), Planning (2) |
| **Claude Code** | ~15 | File I/O (2), Edit (1), Search (2), Shell (1), Web (2), Tasks (3), Skills (1), Notebook (1), Worktree (1) |
| **Codex CLI** | ~8 | File ops, Shell, Search (basic) |
| **OpenCode** | ~12 | File I/O, Edit, Search, Shell, Web, Tasks |

---

## Sources

- [Gemini CLI GitHub Repository](https://github.com/google-gemini/gemini-cli)
- [Gemini API Tools Overview](https://ai.google.dev/gemini-api/docs/tools)
- [Function Calling with Gemini API](https://ai.google.dev/gemini-api/docs/function-calling)
- [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- [URL Context Tool](https://ai.google.dev/gemini-api/docs/url-context)
- [Code Execution](https://ai.google.dev/gemini-api/docs/code-execution)
- [Computer Use](https://ai.google.dev/gemini-api/docs/computer-use)
- [File Search](https://ai.google.dev/gemini-api/docs/file-search)
- [Grounding with Google Maps](https://ai.google.dev/gemini-api/docs/maps-grounding)
- [Thought Signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [ADK Custom Tools](https://google.github.io/adk-docs/tools-custom/)
- [ADK Python GitHub](https://github.com/google/adk-python)
- [Jules Official Site](https://jules.google/)
- [Jules API Documentation](https://developers.google.com/jules/api)
- [Jules Tools Blog Post](https://developers.googleblog.com/en/meet-jules-tools-a-command-line-companion-for-googles-async-coding-agent/)
- [Introducing Gemini CLI Blog](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/)
- [ADK Blog Post](https://developers.googleblog.com/en/agent-development-kit-easy-to-build-multi-agent-applications/)
- [URL Context GA Announcement](https://developers.googleblog.com/url-context-tool-for-gemini-api-now-generally-available/)
- [File Search Introduction Blog](https://blog.google/innovation-and-ai/technology/developers-tools/file-search-gemini-api/)
