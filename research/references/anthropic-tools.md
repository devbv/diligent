# Anthropic LLM-Native Tools Research

Research into Anthropic's co-evolved tools ecosystem: Claude Code CLI tools, API built-in tools, MCP, Agent SDK, and Agent Skills.

**Date**: 2026-02-24
**Sources**: Anthropic official documentation, reverse-engineered system prompts, community analysis

---

## 1. Claude Code CLI Tools

Claude Code is Anthropic's official CLI agent. It provides a rich set of tools to the underlying Claude model. The tool set has evolved significantly, currently at ~24 tools total (including sub-agent tools, planning tools, and utility tools).

### 1.1 Core File Operations

#### Read
- **Purpose**: Read files from filesystem
- **Parameters**:
  ```json
  {
    "file_path": "string (absolute, required)",
    "offset": "number (optional, line number to start)",
    "limit": "number (optional, line count)"
  }
  ```
- **Supports**: Text, images (PNG, JPG), PDFs (with `pages` param), Jupyter notebooks (.ipynb)
- **Default**: Reads up to 2000 lines; lines > 2000 chars are truncated
- **Output**: `cat -n` format with line numbers starting at 1
- **Design rationale**: Must be called before Edit to prevent blind edits. Supports multimodal content (images, PDFs).

#### Write
- **Purpose**: Create or overwrite files
- **Parameters**:
  ```json
  {
    "file_path": "string (absolute, required)",
    "content": "string (required)"
  }
  ```
- **Design rationale**: Requires prior Read if file exists (prevents accidental overwrites). Preference is always to Edit existing files rather than Write new ones.

#### Edit
- **Purpose**: Exact string replacement in files
- **Parameters**:
  ```json
  {
    "file_path": "string (absolute, required)",
    "old_string": "string (required)",
    "new_string": "string (required)",
    "replace_all": "boolean (optional, default: false)"
  }
  ```
- **Design rationale**: The `str_replace` approach is central to Anthropic's editing philosophy. It requires exact indentation matching. The edit FAILS if `old_string` is not unique in the file (must provide more context or use `replace_all`). This is safer than line-number-based editing because it's resilient to file changes between reads. Claude is specifically trained/optimized to use this pattern.

#### MultiEdit
- **Purpose**: Multiple edits on a single file in one call
- **Parameters**:
  ```json
  {
    "file_path": "string (required)",
    "edits": [
      {
        "old_string": "string",
        "new_string": "string",
        "replace_all": "boolean (optional)"
      }
    ]
  }
  ```
- **Design rationale**: Reduces round trips for multi-edit operations on a single file.

#### NotebookEdit
- **Purpose**: Edit Jupyter notebook cells
- **Parameters**:
  ```json
  {
    "notebook_path": "string (absolute, required)",
    "new_source": "string (required)",
    "cell_id": "string (optional)",
    "cell_type": "string (optional, 'code' | 'markdown')",
    "edit_mode": "string (optional, 'replace' | 'insert' | 'delete')"
  }
  ```

### 1.2 Search Tools

#### Glob
- **Purpose**: Fast file pattern matching by name
- **Parameters**:
  ```json
  {
    "pattern": "string (required, glob expression)",
    "path": "string (optional, defaults to cwd)"
  }
  ```
- **Returns**: Matching file paths sorted by modification time
- **Design rationale**: Preferred over `find` command for file discovery. Works efficiently with any codebase size.

#### Grep
- **Purpose**: Content search using ripgrep
- **Parameters**:
  ```json
  {
    "pattern": "string (required, regex)",
    "path": "string (optional)",
    "output_mode": "string ('content' | 'files_with_matches' | 'count')",
    "glob": "string (optional, file filter like '*.js')",
    "type": "string (optional, file type like 'js', 'py')",
    "-A": "number (optional, lines after match)",
    "-B": "number (optional, lines before match)",
    "-C": "number (optional, context lines)",
    "-i": "boolean (optional, case insensitive)",
    "-n": "boolean (optional, show line numbers, default true)",
    "multiline": "boolean (optional, cross-line matching)",
    "head_limit": "number (optional, limit output)",
    "offset": "number (optional, skip entries)"
  }
  ```
- **Design rationale**: Built on ripgrep (not grep). Always preferred over bash grep. Supports advanced features like multiline matching and output pagination. Note: literal braces need escaping (`interface\\{\\}` to find `interface{}`).

### 1.3 Command Execution

#### Bash
- **Purpose**: Execute shell commands in persistent session
- **Parameters**:
  ```json
  {
    "command": "string (required)",
    "description": "string (optional, 5-10 word summary)",
    "timeout": "number (optional, default 120000ms, max 600000ms)",
    "run_in_background": "boolean (optional)"
  }
  ```
- **Design rationale**: Persistent shell session that maintains state (env vars, cwd). NOT meant for file operations (dedicated tools preferred). Includes extensive security analysis of commands. Working directory resets between calls in agent threads (must use absolute paths).

#### BashOutput
- **Purpose**: Retrieve output from background shells
- **Parameters**:
  ```json
  {
    "bash_id": "string (required)",
    "filter": "string (optional, regex)"
  }
  ```
- Returns only new output since last check.

#### KillShell
- **Purpose**: Terminate running background bash shells
- **Parameters**: `{"shell_id": "string"}`

### 1.4 Web Tools

#### WebFetch
- **Purpose**: Fetch and analyze web content
- **Parameters**:
  ```json
  {
    "url": "string (fully-formed URL, required)",
    "prompt": "string (extraction instructions, required)"
  }
  ```
- **Design**: Converts HTML to markdown. Processes content with a small, fast model. 15-minute cache. Auto-upgrades HTTP to HTTPS. Will FAIL for authenticated/private URLs.

#### WebSearch
- **Purpose**: Search the web for current information
- **Parameters**:
  ```json
  {
    "query": "string (required)",
    "allowed_domains": "string[] (optional)",
    "blocked_domains": "string[] (optional)"
  }
  ```
- **Design**: Provides up-to-date information beyond knowledge cutoff. Returns search result blocks with markdown hyperlinks.

### 1.5 Task Management & Planning

#### TaskCreate / TaskUpdate / TaskList / TaskGet
- **Purpose**: Structured task tracking for complex multi-step work
- **TaskCreate Parameters**:
  ```json
  {
    "subject": "string (imperative form, required)",
    "description": "string (detailed, required)",
    "activeForm": "string (present continuous for spinner)"
  }
  ```
- **TaskUpdate Parameters**:
  ```json
  {
    "taskId": "string (required)",
    "status": "string ('pending' | 'in_progress' | 'completed' | 'deleted')",
    "subject": "string (optional)",
    "description": "string (optional)",
    "addBlocks": "string[] (optional)",
    "addBlockedBy": "string[] (optional)",
    "owner": "string (optional)",
    "metadata": "object (optional)"
  }
  ```
- **Design**: Supports dependencies between tasks (blocks/blockedBy). Tasks progress: pending -> in_progress -> completed. Used for tracking complex multi-step work.

#### TodoWrite (Legacy)
- **Purpose**: Create/manage task lists (short-term memory)
- **Parameters**:
  ```json
  {
    "todos": [
      {
        "content": "string",
        "activeForm": "string",
        "status": "string ('pending' | 'in_progress' | 'completed')"
      }
    ]
  }
  ```
- Creates JSON files in `~/.claude/todos/` as conversation-scoped short-term memory.

#### EnterPlanMode / ExitPlanMode
- **Purpose**: Planning mode for complex implementation tasks
- **ExitPlanMode Parameters**: `{"plan": "string (markdown-formatted plan)"}`
- In plan mode, agent switches to read-only tools (Read, Glob, Grep, Bash) with Sonnet model.

### 1.6 Sub-Agent System

#### Task (Sub-agent spawning)
- **Purpose**: Launch autonomous sub-agents for focused subtasks
- **Parameters**:
  ```json
  {
    "subagent_type": "string ('general-purpose' | 'statusline-setup' | 'output-style-setup')",
    "prompt": "string (complete task instructions)",
    "description": "string (3-5 word summary)"
  }
  ```
- **Design**: Main agent extracts a task from conversation context. Sub-agent works autonomously (no back-and-forth). Returns final result as tool result. Sub-agents have restricted tool access.

#### Sub-Agent Types:
- **Explore mode**: Uses Haiku model. Read-only tools (Glob, Grep, Read, safe bash). Fast codebase exploration.
- **Plan mode**: Uses Sonnet model. Read-only mode. Planning complex implementations.
- **Task mode**: General-purpose autonomous agent.

### 1.7 Other Tools

#### Skill
- **Purpose**: Execute a skill within the conversation
- **Parameters**: `{"skill": "string (required)", "args": "string (optional)"}`
- Skills are modular capabilities (SKILL.md + scripts + resources) loaded progressively.

#### AskUserQuestion
- **Purpose**: Ask the user clarifying questions
- Available in Agent SDK for interactive scenarios.

#### EnterWorktree
- **Purpose**: Create isolated git worktree for a session
- **Parameters**: `{"name": "string (optional)"}`
- Creates worktree in `.claude/worktrees/` with a new branch.

#### ToolSearch
- **Purpose**: Search through available tools dynamically
- Used when many tools are available (e.g., with MCP servers).

#### Computer (Chrome automation)
- Available in some configurations for browser-based automation.

#### Sleep
- **Purpose**: Pause execution for a duration.

### 1.8 Claude Code System Prompt Key Directives

- "Be concise, direct, and to the point" (responses displayed in CLI)
- "Answer with fewer than 4 lines unless detail requested"
- All file paths must be absolute
- Follow existing code conventions
- "Refuse to write code that may be used maliciously"
- Batch independent tool calls for parallel execution
- Security: Command prefix detection, file path extraction, URL access restrictions

---

## 2. Anthropic API Built-in Tools

These are "schema-less" tools where "the schema is built into Claude's model and can't be modified" (official docs). No input_schema needed in the API request.

### 2.1 Text Editor Tool

#### Versions
| Model | Tool Version | Tool Name |
|-------|-------------|-----------|
| Claude 4.x | `text_editor_20250728` | `str_replace_based_edit_tool` |
| Claude Sonnet 3.7 | `text_editor_20250124` | `str_replace_editor` |
| Claude Sonnet 3.5 | `text_editor_20241022` | `str_replace_editor` |

#### API Usage
```json
{
  "type": "text_editor_20250728",
  "name": "str_replace_based_edit_tool",
  "max_characters": 10000
}
```
- No `input_schema` required -- schema is built into the model
- `max_characters` (optional, 20250728+): Controls truncation when viewing large files

#### Commands

**view** -- Examine file contents or list directory
```json
{
  "command": "view",
  "path": "file_or_dir_path",
  "view_range": [start_line, end_line]  // optional, 1-indexed, -1 = EOF
}
```

**str_replace** -- Replace exact text in file
```json
{
  "command": "str_replace",
  "path": "file_path",
  "old_str": "text to replace (exact match including whitespace)",
  "new_str": "replacement text"
}
```

**create** -- Create new file
```json
{
  "command": "create",
  "path": "file_path",
  "file_text": "file content"
}
```

**insert** -- Insert text at specific line
```json
{
  "command": "insert",
  "path": "file_path",
  "insert_line": 0,  // line after which to insert (0 = beginning)
  "insert_text": "text to insert"
}
```

**undo_edit** -- Revert last edit (Sonnet 3.7 only, NOT in Claude 4)
```json
{
  "command": "undo_edit",
  "path": "file_path"
}
```

#### Design Rationale: str_replace Philosophy
The `str_replace` approach is Anthropic's core editing paradigm:
1. **Exact matching**: Requires precise text match (including whitespace/indentation)
2. **Unique matching**: Must match exactly one location (prevents ambiguous edits)
3. **Context-resilient**: Unlike line-number edits, works even if file changes between reads
4. **Model-native**: Claude is specifically trained to generate accurate str_replace operations
5. **Safety**: Implementors validate uniqueness, return errors on 0 or >1 matches

Token overhead: ~700 input tokens per tool definition.

### 2.2 Bash Tool

#### Versions
| Model | Tool Version |
|-------|-------------|
| Claude 4.x, Sonnet 3.7 | `bash_20250124` |
| Claude Sonnet 3.5 | `bash_20241022` |

#### API Usage
```json
{
  "type": "bash_20250124",
  "name": "bash"
}
```

#### Parameters (model-generated)
```json
{
  "command": "string",     // Required unless restart
  "restart": "boolean"     // Optional, restart session
}
```

#### Design
- Schema-less (built into model weights)
- Persistent session maintains state between commands
- No interactive commands (vim, less, password prompts)
- Token overhead: ~245 input tokens
- The host application is responsible for executing commands and returning results

### 2.3 Computer Use Tool

#### Versions
| Model | Tool Version | Beta Header |
|-------|-------------|-------------|
| Opus 4.6, Sonnet 4.6, Opus 4.5 | `computer_20251124` | `computer-use-2025-11-24` |
| Other supported models | `computer_20250124` | `computer-use-2025-01-24` |
| Sonnet 3.5 | `computer_20241022` | `computer-use-2024-10-22` |

#### API Usage
```json
{
  "type": "computer_20251124",
  "name": "computer",
  "display_width_px": 1024,
  "display_height_px": 768,
  "display_number": 1,
  "enable_zoom": true
}
```

#### Actions
**Basic (all versions)**: screenshot, left_click, type, key, mouse_move
**Enhanced (20250124+)**: scroll, left_click_drag, right_click, middle_click, double_click, triple_click, left_mouse_down, left_mouse_up, hold_key, wait
**Enhanced (20251124+)**: All above + zoom (view specific screen region at full resolution)

#### Action Examples
```json
{"action": "screenshot"}
{"action": "left_click", "coordinate": [500, 300]}
{"action": "type", "text": "Hello, world!"}
{"action": "scroll", "coordinate": [500, 400], "scroll_direction": "down", "scroll_amount": 3}
{"action": "zoom", "region": [100, 200, 400, 350]}
{"action": "left_click", "coordinate": [500, 300], "text": "shift"}  // modifier keys
```

Token overhead: ~735 input tokens per tool definition. System prompt adds 466-499 tokens.

### 2.4 Web Search Tool (API)

#### Versions
| Version | Features |
|---------|----------|
| `web_search_20260209` | Dynamic filtering with code execution (Opus 4.6, Sonnet 4.6) |
| `web_search_20250305` | Basic web search |

#### API Usage
```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com"],
  "blocked_domains": ["untrusted.com"],
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

#### Design
- Server-side tool execution (model decides when to search)
- Uses Brave Search as provider
- Always returns citations with `web_search_result_location`
- `encrypted_content` must be passed back for multi-turn citation support
- Pricing: $10 per 1,000 searches + token costs
- Response includes `server_tool_use` (query) + `web_search_tool_result` (results)

### 2.5 Web Fetch Tool (API)

#### Version: `web_fetch_20250910` / `web_fetch_20260209`

```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch"
}
```

- Fetches full text content from web pages and PDFs
- Security: Can only fetch URLs that appeared in conversation context
- Supports dynamic filtering with code execution (20260209)

### 2.6 Code Execution Tool

#### Version: `code_execution_20250825`

```json
{
  "type": "code_execution_20250825",
  "name": "code_execution"
}
```

#### Design
- Runs in Anthropic's secure sandboxed container (not user's machine)
- Automatically provides two sub-tools:
  - `bash_code_execution`: Run shell commands
  - `text_editor_code_execution`: View, create, edit files
- Container specs: Python 3.11, 5GiB RAM, 5GiB disk, 1 CPU, no internet
- Pre-installed: pandas, numpy, scipy, scikit-learn, matplotlib, seaborn, sympy, etc.
- Container reuse via `container` parameter across requests
- Containers expire 30 days after creation
- **Free when used with web_search_20260209 or web_fetch_20260209**
- Otherwise: $0.05/hour/container (1,550 free hours/month/org)

#### Powers Two Advanced Features:
1. **Dynamic filtering**: In web search/fetch, code execution filters results before context window
2. **Programmatic tool calling**: Claude writes code to orchestrate multiple tool calls

---

## 3. Advanced Tool Use Features

### 3.1 Tool Search Tool
```json
{
  "type": "tool_search_tool_regex_20251119",
  "name": "tool_search_tool_regex"
}
```
- Tools marked `"defer_loading": true` are discoverable on-demand
- Claude only sees search tool initially; loads specific definitions when needed
- **85% reduction** in tool-definition tokens (77K -> 8.7K)
- Accuracy improvement: Opus 4 from 49% to 74%
- Beta: `advanced-tool-use-2025-11-20`

### 3.2 Programmatic Tool Calling
- Claude writes Python code to orchestrate multiple tool calls in sandbox
- Intermediate results stay in sandbox; only final output enters context
- **37% token reduction** on complex tasks
- Tools opt in via `"allowed_callers": ["code_execution_20250825"]`
- Tool calls include `"caller": {"type": "code_execution_20250825", "tool_id": "srvtoolu_abc"}`

### 3.3 Tool Use Examples
```json
{
  "name": "create_ticket",
  "input_schema": {...},
  "input_examples": [
    {
      "title": "Login page returns 500 error",
      "priority": "critical",
      "labels": ["bug", "authentication"]
    }
  ]
}
```
- Demonstrates correct usage beyond JSON Schema
- **Accuracy improvement**: 72% to 90% on complex parameter handling

---

## 4. MCP (Model Context Protocol)

### 4.1 Overview
- Open protocol for connecting LLM applications to external data/tools
- Uses JSON-RPC 2.0 messages
- Architecture: Hosts (LLM apps) -> Clients (connectors) -> Servers (capability providers)
- Spec version: 2025-11-25
- Donated to Agentic AI Foundation (Linux Foundation) in Dec 2025
- 97M+ monthly SDK downloads

### 4.2 Core Concepts

**Server Features** (provided to clients):
- **Resources**: Context and data (for user or AI model)
- **Prompts**: Templated messages and workflows
- **Tools**: Functions for the AI model to execute

**Client Features** (provided to servers):
- **Sampling**: Server-initiated agentic behaviors / recursive LLM interactions
- **Roots**: Server-initiated inquiries into URI/filesystem boundaries
- **Elicitation**: Server-initiated requests for user information

### 4.3 Tool Definition Format
```json
{
  "name": "tool_name",
  "description": "Description of what the tool does",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param1": {
        "type": "string",
        "description": "Parameter description"
      }
    },
    "required": ["param1"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {...}
  }
}
```

**Tool name constraints**: 1-128 chars, case-sensitive, ASCII letters/digits/underscore/hyphen/dot only.

### 4.4 2025-11-25 Spec Updates
- Asynchronous operations (Tasks)
- Statelessness support
- Server identity
- Official community-driven registry

### 4.5 MCP Apps Extension (SEP-1865)
- Standardized interactive UI capabilities
- HTML rendered in sandboxed iframes
- Co-authored by Anthropic and OpenAI

---

## 5. Agent SDK

### 5.1 Overview
The Claude Agent SDK (formerly Claude Code SDK) provides Claude Code's tools, agent loop, and context management as a programmable library. Available in Python and TypeScript.

### 5.2 Core API

```typescript
// TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

```python
# Python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Find and fix the bug in auth.py",
    options=ClaudeAgentOptions(allowed_tools=["Read", "Edit", "Bash"]),
):
    print(message)
```

### 5.3 Built-in Tools Available

| Tool | What it does |
|------|-------------|
| Read | Read any file in working directory |
| Write | Create new files |
| Edit | Make precise edits to existing files |
| Bash | Run terminal commands, scripts, git operations |
| Glob | Find files by pattern |
| Grep | Search file contents with regex |
| WebSearch | Search the web |
| WebFetch | Fetch and parse web pages |
| AskUserQuestion | Ask user clarifying questions |
| Task | Spawn sub-agents |

### 5.4 Tool Configuration
```typescript
// Strict allowlist
options: { allowedTools: ["Bash", "Read", "Edit"] }

// Disable all built-in tools
options: { allowedTools: [] }

// All default tools
options: { tools: { type: "preset", preset: "claude_code" } }
```

### 5.5 Key Capabilities
- **Hooks**: PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, UserPromptSubmit
- **Sub-agents**: Custom agents with specialized instructions and tool restrictions
- **MCP integration**: Connect external systems via MCP servers
- **Permissions**: Read-only, accept-edits, bypass-permissions modes
- **Sessions**: Resume/fork sessions with full context preservation
- **Skills**: Filesystem-based modular capabilities (SKILL.md)
- **Plugins**: Extend with custom commands, agents, MCP servers

---

## 6. Agent Skills

### 6.1 Overview
Agent Skills are an open standard (agentskills.io) for modular AI agent capabilities. Released Dec 2025. Adopted by VS Code, GitHub, Cursor, Goose, Amp, OpenCode.

### 6.2 SKILL.md Format
```markdown
---
name: my-skill
description: Short description for discovery
license: MIT
compatibility:
  - claude-code
  - cursor
allowed-tools:
  - Bash
  - Read
  - Edit
---

# Skill Instructions

Detailed instructions loaded when skill is activated...

## References
- [Additional doc](./references/setup.md)
```

### 6.3 Directory Structure
```
.claude/skills/my-skill/
  SKILL.md          # Required: metadata + instructions
  scripts/          # Optional: executable scripts
  references/       # Optional: additional documentation
  assets/           # Optional: static resources
```

### 6.4 Progressive Disclosure Design
1. **Level 1 (Always loaded)**: Frontmatter metadata (name, description) -- enough for Claude to know when to use it
2. **Level 2 (On demand)**: Full SKILL.md body -- loaded when Claude decides skill is relevant
3. **Level 3+ (As needed)**: Referenced files in scripts/, references/ -- navigated only if required

This minimizes context window consumption while maintaining full capability access.

---

## 7. Key Design Patterns & Philosophy

### 7.1 The str_replace Paradigm
Anthropic's central editing philosophy across all tool surfaces:
- **API text editor**: `str_replace` command
- **Claude Code Edit tool**: `old_string` / `new_string` exact replacement
- **Code execution text_editor**: `str_replace` command
- **Rationale**: Context-resilient (no line numbers), safe (unique match required), model-native (trained behavior)

### 7.2 Schema-less vs Schema-defined Tools
- **Schema-less** (built into model weights): Text Editor, Bash, Computer Use -- no input_schema in API request
- **Schema-defined** (JSON Schema): Custom tools, MCP tools -- full schema required
- **Hybrid**: Code execution provides schema-less sub-tools (bash_code_execution, text_editor_code_execution)

### 7.3 Server-side vs Client-side Execution
- **Server-side** (Anthropic executes): Web Search, Web Fetch, Code Execution -- results returned in `server_tool_use` blocks
- **Client-side** (you execute): Text Editor, Bash, Computer Use, custom tools -- you implement and return results
- **Agent SDK**: Built-in execution for all Claude Code tools

### 7.4 Progressive Context Loading
Multiple mechanisms to minimize context window usage:
1. **Tool Search**: Only load tool definitions when needed (85% reduction)
2. **Programmatic Tool Calling**: Keep intermediate data in sandbox (37% reduction)
3. **Agent Skills Progressive Disclosure**: Load skill content in stages
4. **Web Search Dynamic Filtering**: Code execution filters results before context

### 7.5 Security Model
- **Bash**: Command prefix detection, file path extraction, injection detection
- **Computer Use**: Prompt injection classifiers on screenshots, sandboxed environments
- **Code Execution**: Sandboxed containers, no internet, 5GiB limits
- **Web Fetch**: Can only fetch URLs from conversation context
- **Permissions**: Tool allowlists, permission modes, hook-based validation

### 7.6 Sub-agent Architecture
Claude Code uses model stratification for sub-agents:
- **Haiku**: Explore mode (fast, read-only codebase exploration)
- **Sonnet**: Plan mode (read-only planning), general Task sub-agents
- **Opus**: Main agent reasoning

### 7.7 Tool Naming Conventions
- **API built-in tools**: snake_case with version dates (e.g., `text_editor_20250728`)
- **Claude Code CLI tools**: PascalCase (e.g., `Read`, `Edit`, `Bash`, `Glob`, `Grep`)
- **MCP tools**: dot-separated namespaces (e.g., `github.createPullRequest`)
- **Code execution sub-tools**: snake_case (e.g., `bash_code_execution`)

---

## 8. Complete Tool Inventory Summary

### 8.1 Claude Code CLI Tools (~24 total)

**File Operations**: Read, Write, Edit, MultiEdit, NotebookEdit
**Search**: Glob, Grep
**Execution**: Bash, BashOutput, KillShell
**Web**: WebFetch, WebSearch
**Task Management**: TaskCreate, TaskUpdate, TaskList, TaskGet, TodoWrite
**Planning**: EnterPlanMode, ExitPlanMode
**Sub-agents**: Task (dispatch_agent)
**Other**: Skill, AskUserQuestion, EnterWorktree, ToolSearch, Sleep, Computer

### 8.2 Anthropic API Built-in Tools (7 types)

| Tool Type | Version | Schema-less | Beta Required |
|-----------|---------|------------|---------------|
| Text Editor | `text_editor_20250728` | Yes | No |
| Bash | `bash_20250124` | Yes | No |
| Computer Use | `computer_20251124` | Yes | Yes |
| Web Search | `web_search_20260209` | Yes | No |
| Web Fetch | `web_fetch_20260209` | Yes | No (GA) |
| Code Execution | `code_execution_20250825` | Yes | No |
| Tool Search | `tool_search_tool_regex_20251119` | Yes | Yes |

### 8.3 Token Overhead per API Tool

| Tool | Additional Input Tokens |
|------|------------------------|
| Text Editor | 700 |
| Bash | 245 |
| Computer Use | 735 + ~480 system prompt |
| Web Search | Varies |
| Code Execution | Varies |

---

## Sources

- [Anthropic Text Editor Tool Documentation](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/text-editor-tool)
- [Anthropic Bash Tool Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool)
- [Anthropic Computer Use Tool Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic Web Search Tool Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Anthropic Code Execution Tool Documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
- [Anthropic Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Agent Skills Specification](https://agentskills.io/specification)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Claude Code System Prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [Claude Code Tools Gist](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [Reverse Engineering Claude Code (Kir Shatrov)](https://kirshatrov.com/posts/claude-code-internals)
- [Claude Code Built-in Tools Reference](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [Claude Code GitHub Repository](https://github.com/anthropics/claude-code)
- [Anthropic Agent Skills Engineering Blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
