# OpenAI LLM-Native Tools Research

Research date: 2026-02-24
Sources: OpenAI official documentation, Codex CLI GitHub repository, OpenAI Cookbook, Responses API reference

## Table of Contents

1. [Overview & Philosophy](#1-overview--philosophy)
2. [Codex CLI Tools (Local Agent)](#2-codex-cli-tools-local-agent)
3. [Responses API Built-in Tools](#3-responses-api-built-in-tools)
4. [Function Calling Specification](#4-function-calling-specification)
5. [Tool-Model Co-Evolution](#5-tool-model-co-evolution)
6. [Key Design Patterns & Takeaways](#6-key-design-patterns--takeaways)

---

## 1. Overview & Philosophy

OpenAI's tool strategy operates on two distinct levels:

1. **Hosted API tools** (Responses API): Built-in tools that run on OpenAI's infrastructure (code_interpreter, file_search, web_search, etc.)
2. **Local agent tools** (Codex CLI): Tools that the model calls and the client executes locally (apply_patch, shell, read_file, etc.)
3. **Function calling**: User-defined tools with JSON Schema definitions that the model generates arguments for

The key philosophical distinction is that OpenAI's models are **trained specifically to use their own tool formats**. The apply_patch tool uses a custom "V4A diff format" that models are trained on during post-training. This co-evolution means the model and tool format are optimized together, not independently.

### Design Principles

- **Model-native formats**: Rather than using existing formats (like unified diff), OpenAI designed custom formats (V4A) and trained models specifically on them
- **Freeform tools with grammars**: Some tools (apply_patch, js_repl) use constrained-decoding grammars (Lark format) instead of JSON schemas, allowing the model to emit raw text in a structured format
- **Progressive trust**: Sandbox/approval modes (untrusted, on-request, never) control what the model can do without human approval
- **Multi-turn iteration**: The Responses API supports `previous_response_id` for persisting reasoning across tool calls, enabling genuine iterative agent loops

---

## 2. Codex CLI Tools (Local Agent)

Source: https://github.com/openai/codex (codex-rs/core/src/tools/)

The Codex CLI is OpenAI's open-source coding agent built in Rust. It provides the following tools to the model:

### 2.1 `apply_patch` (File Editing - Primary)

**Philosophy**: Instead of having the model output full file contents or use existing diff formats, OpenAI designed a custom "V4A" diff format that is:
- Simpler than unified diff (no line numbers required)
- Context-aware (uses @@ headers for class/function disambiguation)
- File-oriented (supports create, update, delete, rename in one patch)
- Trained into the model during post-training

**Two implementation variants exist:**

#### Freeform Variant (Primary, for trained models)
```
ToolSpec::Freeform {
    name: "apply_patch",
    description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    format: {
        type: "grammar",
        syntax: "lark",
        definition: <Lark grammar below>
    }
}
```

The model outputs raw patch text (not JSON) constrained by a Lark grammar:

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
```

#### JSON Variant (Fallback, for non-trained models)
```json
{
    "name": "apply_patch",
    "description": "Use the `apply_patch` tool to edit files...",
    "parameters": {
        "type": "object",
        "properties": {
            "input": {
                "type": "string",
                "description": "The entire contents of the apply_patch command"
            }
        },
        "required": ["input"],
        "additionalProperties": false
    }
}
```

When using the JSON variant, the full V4A format specification is placed in the tool description to teach the model the format.

#### V4A Diff Format Specification

Full grammar (from `apply_patch_tool_instructions.md`):

```
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE
```

**Operations:**

| Operation | Header | Content |
|-----------|--------|---------|
| Create file | `*** Add File: <path>` | Lines prefixed with `+` |
| Delete file | `*** Delete File: <path>` | Nothing follows |
| Update file | `*** Update File: <path>` | Hunks with context/change lines |
| Rename + update | `*** Update File: <path>` then `*** Move to: <new>` | Hunks |

**Context rules:**
- Show 3 lines of context above and below each change
- If changes are within 3 lines, don't duplicate context
- Use `@@ class ClassName` or `@@ def method():` for disambiguation
- Use multiple `@@` for nested disambiguation (e.g., class then method)
- File paths must be **relative, never absolute**

**Example:**
```
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

**Invocation format in Codex CLI:**
```json
{"command": ["apply_patch", "*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch\n"]}
```

### 2.2 `shell` (Command Execution - Array variant)

**Parameters:**
```json
{
    "name": "shell",
    "description": "Runs a shell command and returns its output. The arguments to `shell` will be passed to execvp(). Most terminal commands should be prefixed with [\"bash\", \"-lc\"]. Always set the `workdir` param when using the shell function. Do not use `cd` unless absolutely necessary.",
    "parameters": {
        "type": "object",
        "properties": {
            "command": {
                "type": "array",
                "items": { "type": "string" },
                "description": "The command to execute"
            },
            "workdir": {
                "type": "string",
                "description": "The working directory to execute the command in"
            },
            "timeout_ms": {
                "type": "number",
                "description": "The timeout for the command in milliseconds"
            },
            "sandbox_permissions": {
                "type": "string",
                "description": "Sandbox permissions for the command. Set to \"require_escalated\" to request running without sandbox restrictions; defaults to \"use_default\"."
            },
            "justification": {
                "type": "string",
                "description": "Only set if sandbox_permissions is \"require_escalated\". Request approval from the user..."
            },
            "prefix_rule": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Only specify when sandbox_permissions is `require_escalated`. Suggest a prefix command pattern..."
            }
        },
        "required": ["command"],
        "additionalProperties": false
    }
}
```

**Windows variant**: Uses PowerShell commands (e.g., `["powershell.exe", "-Command", "Get-ChildItem -Force"]`).

### 2.3 `shell_command` (Command Execution - String variant)

Similar to `shell` but takes a single command string instead of an array:

```json
{
    "name": "shell_command",
    "description": "Runs a shell command and returns its output. Always set the `workdir` param when using the shell_command function.",
    "parameters": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell script to execute in the user's default shell"
            },
            "workdir": {
                "type": "string",
                "description": "The working directory to execute the command in"
            },
            "timeout_ms": {
                "type": "number",
                "description": "The timeout for the command in milliseconds"
            },
            "login": {
                "type": "boolean",
                "description": "Whether to run the shell with login shell semantics. Defaults to true."
            }
        },
        "required": ["command"],
        "additionalProperties": false
    }
}
```

### 2.4 `exec_command` (PTY-based Execution)

More advanced shell execution with PTY support for interactive processes:

```json
{
    "name": "exec_command",
    "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    "parameters": {
        "type": "object",
        "properties": {
            "cmd": {
                "type": "string",
                "description": "Shell command to execute."
            },
            "workdir": {
                "type": "string",
                "description": "Optional working directory to run the command in; defaults to the turn cwd."
            },
            "shell": {
                "type": "string",
                "description": "Shell binary to launch. Defaults to the user's default shell."
            },
            "tty": {
                "type": "boolean",
                "description": "Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process."
            },
            "yield_time_ms": {
                "type": "number",
                "description": "How long to wait (in milliseconds) for output before yielding."
            },
            "max_output_tokens": {
                "type": "number",
                "description": "Maximum number of tokens to return. Excess output will be truncated."
            },
            "login": {
                "type": "boolean",
                "description": "Whether to run the shell with -l/-i semantics. Defaults to true."
            }
        },
        "required": ["cmd"],
        "additionalProperties": false
    }
}
```

### 2.5 `write_stdin` (Interactive Session Input)

For ongoing interaction with PTY sessions started by `exec_command`:

```json
{
    "name": "write_stdin",
    "description": "Writes characters to an existing unified exec session and returns recent output.",
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {
                "type": "number",
                "description": "Identifier of the running unified exec session."
            },
            "chars": {
                "type": "string",
                "description": "Bytes to write to stdin (may be empty to poll)."
            },
            "yield_time_ms": {
                "type": "number",
                "description": "How long to wait (in milliseconds) for output before yielding."
            },
            "max_output_tokens": {
                "type": "number",
                "description": "Maximum number of tokens to return. Excess output will be truncated."
            }
        },
        "required": ["session_id"],
        "additionalProperties": false
    }
}
```

### 2.6 `read_file` (File Reading)

Advanced file reading with slice and indentation-aware modes:

```json
{
    "name": "read_file",
    "description": "Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.",
    "parameters": {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Absolute path to the file"
            },
            "offset": {
                "type": "number",
                "description": "The line number to start reading from. Must be 1 or greater."
            },
            "limit": {
                "type": "number",
                "description": "The maximum number of lines to return."
            },
            "mode": {
                "type": "string",
                "description": "Optional mode selector: \"slice\" for simple ranges (default) or \"indentation\" to expand around an anchor line."
            },
            "indentation": {
                "type": "object",
                "properties": {
                    "anchor_line": {
                        "type": "number",
                        "description": "Anchor line to center the indentation lookup on (defaults to offset)."
                    },
                    "max_levels": {
                        "type": "number",
                        "description": "How many parent indentation levels (smaller indents) to include."
                    },
                    "include_siblings": {
                        "type": "boolean",
                        "description": "When true, include additional blocks that share the anchor indentation."
                    },
                    "include_header": {
                        "type": "boolean",
                        "description": "Include doc comments or attributes directly above the selected block."
                    },
                    "max_lines": {
                        "type": "number",
                        "description": "Hard cap on the number of lines returned when using indentation mode."
                    }
                },
                "additionalProperties": false
            }
        },
        "required": ["file_path"],
        "additionalProperties": false
    }
}
```

**Notable**: The "indentation" mode is a unique feature that expands outward from an anchor line based on indentation levels, useful for reading logical code blocks without knowing exact line ranges.

### 2.7 `list_dir` (Directory Listing)

```json
{
    "name": "list_dir",
    "description": "Lists entries in a local directory with 1-indexed entry numbers and simple type labels.",
    "parameters": {
        "type": "object",
        "properties": {
            "dir_path": {
                "type": "string",
                "description": "Absolute path to the directory to list."
            },
            "offset": {
                "type": "number",
                "description": "The entry number to start listing from. Must be 1 or greater."
            },
            "limit": {
                "type": "number",
                "description": "The maximum number of entries to return."
            },
            "depth": {
                "type": "number",
                "description": "The maximum directory depth to traverse. Must be 1 or greater."
            }
        },
        "required": ["dir_path"],
        "additionalProperties": false
    }
}
```

### 2.8 `grep_files` (Content Search)

```json
{
    "name": "grep_files",
    "description": "Finds files whose contents match the pattern and lists them by modification time.",
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regular expression pattern to search for."
            },
            "include": {
                "type": "string",
                "description": "Optional glob that limits which files are searched (e.g. \"*.rs\" or \"*.{ts,tsx}\")."
            },
            "path": {
                "type": "string",
                "description": "Directory or file path to search. Defaults to the session's working directory."
            },
            "limit": {
                "type": "number",
                "description": "Maximum number of file paths to return (defaults to 100)."
            }
        },
        "required": ["pattern"],
        "additionalProperties": false
    }
}
```

### 2.9 `update_plan` (Task Planning)

```json
{
    "name": "update_plan",
    "description": "Updates the task plan. Provide an optional explanation and a list of plan items, each with a step and status. At most one step can be in_progress at a time.",
    "parameters": {
        "type": "object",
        "properties": {
            "explanation": {
                "type": "string"
            },
            "plan": {
                "type": "array",
                "description": "The list of steps",
                "items": {
                    "type": "object",
                    "properties": {
                        "step": { "type": "string" },
                        "status": {
                            "type": "string",
                            "description": "One of: pending, in_progress, completed"
                        }
                    },
                    "required": ["step", "status"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["plan"],
        "additionalProperties": false
    }
}
```

### 2.10 `view_image` (Image Viewing)

```json
{
    "name": "view_image",
    "description": "View a local image from the filesystem (only use if given a full filepath by the user, and the image isn't already attached to the thread context within <image ...> tags).",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Local filesystem path to an image file"
            }
        },
        "required": ["path"],
        "additionalProperties": false
    }
}
```

### 2.11 `js_repl` (JavaScript REPL - Freeform)

A persistent Node.js kernel with top-level await:

```
ToolSpec::Freeform {
    name: "js_repl",
    description: "Runs JavaScript in a persistent Node kernel with top-level await. This is a freeform tool: send raw JavaScript source text, optionally with a first-line pragma like `// codex-js-repl: timeout_ms=15000`; do not send JSON/quotes/markdown fences.",
    format: {
        type: "grammar",
        syntax: "lark",
        definition: <grammar that rejects JSON-wrapped, quoted, or fenced input>
    }
}
```

### 2.12 `js_repl_reset` (REPL Reset)

```json
{
    "name": "js_repl_reset",
    "description": "Restarts the js_repl kernel for this run and clears persisted top-level bindings.",
    "parameters": {}
}
```

### 2.13 Multi-Agent Tools

For orchestrating sub-agents:
- `spawn_agent` - Launch a sub-agent with a role and instructions
- `send_input` - Send input to a running agent
- `resume_agent` - Resume a paused agent
- `wait` - Wait for an agent to complete (with timeout)
- `close_agent` - Terminate an agent

### 2.14 MCP Resource Tools

- `list_mcp_resources` - List resources from MCP servers
- `list_mcp_resource_templates` - List parameterized resource templates
- `read_mcp_resource` - Read a specific MCP resource by server name and URI

### 2.15 `request_user_input` (User Interaction)

Allows the model to ask the user a question and await a response.

### 2.16 `search_tool_bm25` (App/Tool Search)

BM25-based search across available MCP/app tools for discovery.

### Shell Type Selection Logic

Codex CLI dynamically selects between shell tool variants based on model capabilities and feature flags:

```
ConfigShellToolType::Disabled      -> No shell tool
ConfigShellToolType::ShellCommand  -> shell_command (string-based)
ConfigShellToolType::UnifiedExec   -> exec_command + write_stdin (PTY-based)
ConfigShellToolType::Shell (legacy)-> shell (array-based, via execvp)
```

The selection depends on:
- Model capabilities (`model_info.shell_type`)
- Feature flags (ShellTool, ShellZshFork, UnifiedExec)
- Platform capabilities (ConPTY support on Windows)

---

## 3. Responses API Built-in Tools

These are tools hosted and executed by OpenAI's infrastructure. They are passed as tool types in the Responses API.

### 3.1 `web_search` / `web_search_preview`

**Type**: `"web_search"` or `"web_search_preview"` (legacy)

Powered by the same model used for ChatGPT search. The model decides when to search and formulates queries.

```json
{
    "type": "web_search",
    "search_context_size": "low",
    "user_location": {
        "type": "approximate",
        "country": "US",
        "city": "San Francisco",
        "region": "California"
    }
}
```

**Parameters:**
- `search_context_size`: Controls amount of context returned ("low", "medium", "high")
- `user_location`: Location context for location-aware searches
  - `country`: Two-letter ISO country code
  - `city`: Optional city
  - `region`: Optional region

**Domain filtering** (allow-list only):
```json
{
    "type": "web_search",
    "filters": {
        "type": "allow_list",
        "domains": ["openai.com", "docs.python.org"]
    }
}
```

Up to 100 domains. Omit HTTP/HTTPS prefix.

**Output**: Returns `web_search_call` items with search results including URLs and content, which the model can then cite.

### 3.2 `file_search`

**Type**: `"file_search"`

Semantic and keyword search over uploaded documents stored in vector stores.

```json
{
    "type": "file_search",
    "vector_store_ids": ["vs_abc123"],
    "max_num_results": 5,
    "filters": {
        "type": "and",
        "filters": [
            {"type": "eq", "key": "category", "value": "technical"}
        ]
    }
}
```

**Parameters:**
- `vector_store_ids`: IDs of vector stores to search
- `max_num_results`: Maximum results to return
- `filters`: Attribute-based filtering with comparison operators (eq, ne, gt, gte, lt, lte, in, nin) combinable with and/or

**Vector store configuration:**
- Chunking strategy: "auto" or "static" (configurable max_chunk_size_tokens, chunk_overlap_tokens)
- Default: 800 token chunks with 400 token overlap
- Up to 100M files per vector store (since Nov 2025)

**Pricing**: $0.10/GB vector storage per day, $2.50/1k tool calls

### 3.3 `code_interpreter`

**Type**: `"code_interpreter"`

Runs Python code in a sandboxed container (VM).

```json
{
    "type": "code_interpreter",
    "container": {
        "type": "auto",
        "memory_limit": "4g",
        "file_ids": ["file-abc123"]
    }
}
```

**Container options:**
- `type`: "auto" (creates/reuses automatically) or explicit container ID
- `memory_limit`: "1g" (default), "4g", "16g", or "64g"
- `file_ids`: Files to make available in the container

**Output**: `code_interpreter_call` items with:
- `code`: The Python code executed
- `container_id`: Container identifier
- `outputs`: Logs, images, or other outputs
- `status`: in_progress, completed, incomplete, interpreting, or failed

**Pricing**: $0.03 per container

### 3.4 `computer_use_preview`

**Type**: `"computer_use_preview"`

Uses OpenAI's Computer-Using Agent (CUA) model (`computer-use-preview`) to control computer interfaces through screenshots.

```json
{
    "type": "computer_use_preview",
    "display_width": 1920,
    "display_height": 1080,
    "environment": "browser"
}
```

**Action types the model emits:**
- `click`: Click at (x, y) with optional button specification
- `scroll`: Scroll with scroll_x, scroll_y distances
- `type`: Type text
- `keypress`: Key combinations
- `screenshot`: Request a screenshot
- `wait`: Wait before next action

**Loop pattern:**
1. Send screenshot to model
2. Model returns computer action (click, type, etc.)
3. Execute action in your environment
4. Take new screenshot
5. Send result back to model
6. Repeat until task complete

**Limitations:**
- Beta only, model is `computer-use-preview`
- 38.1% on OSWorld benchmark
- Not recommended for authenticated environments or high-stakes tasks
- Requires `previous_response_id` for multi-turn (reasoning items must be passed back)
- Not available via Chat Completions, only Responses API

### 3.5 `apply_patch` (Responses API Built-in)

**Type**: `"apply_patch"`

A first-class built-in tool in the Responses API for GPT-5.1+ models. Unlike the Codex CLI version, this is hosted by OpenAI.

```json
{
    "type": "apply_patch"
}
```

When used as a first-class tool, you don't provide an input schema. The model emits `apply_patch_call` items with:
- `id`: Unique identifier
- `type`: "apply_patch_call"
- `operation`: Contains `type` (create_file/update_file/delete_file), `path`, and optional `diff`

**Response loop:**
1. Call Responses API with `tools=[{"type": "apply_patch"}]`
2. Model returns `apply_patch_call` objects
3. You apply patches in your environment
4. Report results via `apply_patch_call_output` with status and optional output
5. Model continues or explains changes

**Error handling:**
```json
{
    "type": "apply_patch_call_output",
    "call_id": "call_abc",
    "status": "failed",
    "output": "Error: File not found at path 'lib/baz.py'"
}
```

### 3.6 `shell` (Responses API - Hosted)

**Type**: `"shell"` with environment configuration

The newer replacement for `local_shell`. Supports hosted containers or local execution.

**Hosted shell:**
```json
{
    "type": "shell",
    "environment": {
        "type": "container_auto"
    }
}
```

Runtime: Debian 12, pre-installed Python 3.11, Node.js 22.16, Java 17.0, PHP 8.2, Ruby 3.1, Go 1.23. No sudo access, no interactive TTY. Expires after 20 minutes of inactivity.

**Container reuse:**
```json
{
    "type": "shell",
    "environment": {
        "type": "container_reference",
        "container_id": "cntr_..."
    }
}
```

**Network access with domain allowlisting:**
```json
{
    "type": "shell",
    "environment": {
        "type": "container_auto",
        "network_policy": {
            "type": "allowlist",
            "allowed_domains": ["pypi.org", "github.com"],
            "domain_secrets": [
                {
                    "domain": "api.example.com",
                    "name": "API_KEY",
                    "value": "secret-token"
                }
            ]
        }
    }
}
```

Models see placeholder names like `$API_KEY` instead of actual credentials.

**Local shell mode:**
```json
{
    "type": "shell",
    "environment": { "type": "local" }
}
```

Returns `shell_call` items; you execute and return `shell_call_output`:
```json
{
    "type": "shell_call_output",
    "call_id": "call_id",
    "output": [{
        "stdout": "...",
        "stderr": "...",
        "outcome": { "type": "exit", "exit_code": 0 }
    }]
}
```

### 3.7 `local_shell` (Deprecated)

**Type**: `"local_shell"`

The older version, only for `codex-mini-latest`. Replaced by `shell` with `environment: { type: "local" }`.

Returns `local_shell_call` items with:
- `command` (string or array)
- `working_directory` (optional)
- `env` (optional)
- `timeout_ms` (optional)

### 3.8 `image_generation`

Available as a tool in the Responses API for models that support it (GPT-4o+).

Models: gpt-image-1.5, gpt-image-1, gpt-image-1-mini, DALL-E models.

Output formats: png, webp, jpeg. Supports transparent backgrounds (png, webp only).

### 3.9 MCP (Remote)

**Type**: `"mcp"`

Connect to remote MCP servers:
```json
{
    "type": "mcp",
    "server_url": "https://mcp.example.com",
    "authorization": {
        "type": "bearer",
        "token": "..."
    }
}
```

---

## 4. Function Calling Specification

### 4.1 How Function Calling Works

Function calling is a multi-step conversation:

1. **Define tools** with JSON Schema in the `tools` parameter
2. **Model decides** whether to call a function based on the conversation
3. **Model generates** structured JSON arguments matching the schema
4. **Application executes** the function with generated arguments
5. **Return results** to the model for further processing

### 4.2 Tool Definition Format

```json
{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "strict": true,
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and state, e.g. 'San Francisco, CA'"
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"]
                }
            },
            "required": ["location"],
            "additionalProperties": false
        }
    }
}
```

### 4.3 `tool_choice` Parameter

Controls when the model calls functions:

| Value | Behavior |
|-------|----------|
| `"auto"` (default) | Model decides whether to call a function |
| `"none"` | Model never calls functions |
| `"required"` | Model must call at least one function |
| `{"type": "function", "function": {"name": "..."}}` | Force specific function |

### 4.4 Structured Outputs (Strict Mode)

Setting `strict: true` ensures function calls **reliably** adhere to the schema (not best-effort):

**Requirements when `strict: true`:**
- `additionalProperties` must be `false` for every object
- All fields in `properties` must be listed in `required`
- Optional fields: use `"type": ["string", "null"]` instead of omitting from required
- NOT compatible with `parallel_tool_calls` (must set to false)

**Benefits:**
- Leverages constrained decoding (like structured outputs)
- 100% schema adherence vs best-effort
- Recommended by OpenAI: "We recommend always enabling strict mode"

### 4.5 Parallel Function Calling

- Models may call multiple functions in a single turn
- Disable with `parallel_tool_calls: false` for exactly 0 or 1 tool calls
- Not possible when using built-in tools
- Not compatible with `strict: true`

### 4.6 Best Practices (from GPT-4.1 Prompting Guide)

**API-based tool passing is preferred**: Use the `tools` field in API requests rather than manually injecting tool descriptions into prompts. This showed a **2% improvement** in benchmark performance and keeps models "within distribution during tool-calling trajectories."

**Tool naming**: "Name tools clearly to indicate their purpose and add a clear, detailed description in the 'description' field."

**Parameter descriptions**: "Well-named parameters with detailed descriptions."

**Examples**: Place examples in the system prompt under `# Examples` rather than in the tool description field.

---

## 5. Tool-Model Co-Evolution

### 5.1 Training on Custom Formats

OpenAI trains models specifically on their tool formats:

- **GPT-4.1**: "Significantly better than GPT-4o at a variety of coding tasks, including agentically solving coding tasks, following diff formats reliably, ensuring consistent tool usage." The model has been "extensively trained on a recommended diff format."

- **GPT-5 / GPT-5.1**: The apply_patch tool with V4A diff format is a first-class built-in. Models emit structured `apply_patch_call` objects natively.

- **codex-mini-latest / GPT-5-Codex**: Optimized specifically for agentic coding with local shell support.

### 5.2 Agentic Prompting Patterns

Three critical prompts that **increased internal benchmarks by ~20%**:

1. **Persistence**: "You are an agent - please keep going until the user's query is completely resolved, before ending your turn."

2. **Tool-calling emphasis**: "If you are not sure about file content or codebase structure pertaining to the user's request, use your tools to read files and gather the relevant information."

3. **Planning**: "You MUST plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls."

### 5.3 Reasoning Persistence

Using `previous_response_id` in the Responses API preserves reasoning traces between tool calls:
- Tau-Bench Retail scores: 73.9% -> 78.2% (statistically significant)
- Enables genuine iterative reasoning across multi-turn tool use

### 5.4 Eagerness Calibration

- `reasoning_effort` parameter: low/medium/high (controls exploration depth)
- Lower = fewer tool calls, faster completion
- Higher = more thorough, more autonomous
- Can set explicit tool call budgets in system prompt
- "Define explicit exploration criteria and early-stop conditions"

### 5.5 Freeform Tools with Grammar Constraints

A unique OpenAI innovation. Instead of forcing all tools into JSON:

```json
{
    "type": "freeform_tool",
    "name": "apply_patch",
    "description": "...",
    "format": {
        "type": "grammar",
        "syntax": "lark",
        "definition": "<Lark grammar>"
    }
}
```

The model outputs raw text constrained by the grammar. This is used for:
- `apply_patch`: Raw V4A diff format (not wrapped in JSON)
- `js_repl`: Raw JavaScript code

Benefits: Avoids JSON escaping overhead for large text blobs, more natural format for diffs and code.

---

## 6. Key Design Patterns & Takeaways

### 6.1 Tool Design Philosophy Comparison

| Aspect | OpenAI Codex CLI | Claude Code | Significance |
|--------|-----------------|-------------|--------------|
| File editing | apply_patch (custom V4A diff, freeform grammar) | Edit (exact string match replacement) | OpenAI uses context-based diffs; Claude uses exact match |
| Shell execution | shell/shell_command/exec_command (3 variants) | Bash (single tool) | OpenAI separates concerns more granularly |
| File reading | read_file (with indentation mode) | Read (offset + limit) | OpenAI adds semantic code-block expansion |
| Planning | update_plan (status tracking) | TodoWrite | Similar concepts |
| Search | grep_files (returns file paths by mod time) | Grep (ripgrep-based, multiple modes) | Claude's Grep is more feature-rich |
| Interactive sessions | write_stdin (PTY interaction) | N/A | Unique to OpenAI |
| Grammar-constrained tools | Freeform tools with Lark grammars | N/A | Unique to OpenAI |

### 6.2 Key Architectural Decisions

1. **Custom diff format over standard formats**: V4A is simpler than unified diff, uses context-based matching (like Claude's exact-string Edit tool), but operates at the diff level rather than exact-string level.

2. **Freeform tools for non-JSON output**: apply_patch and js_repl use Lark grammars for constrained decoding of non-JSON output. This avoids the overhead of JSON-encoding large patches or code.

3. **Multiple shell variants**: Different models and configurations get different shell tools (array-based, string-based, PTY-based), selected dynamically.

4. **Built-in vs local tools**: The same conceptual tool (apply_patch, shell) exists as both a Responses API hosted tool and a Codex CLI local tool, with different interfaces.

5. **AGENTS.md convention**: OpenAI established AGENTS.md (similar to Claude's CLAUDE.md) as a repository-level convention for providing agent instructions. Scope is directory-tree-based with nesting precedence.

### 6.3 Lessons for Our Design

1. **Model-format co-training matters**: OpenAI's biggest improvements come from training models on specific tool formats. We should design tools that align with model training distributions.

2. **Grammar-constrained freeform tools** are a powerful pattern for non-JSON output (diffs, code, etc.). Worth investigating for our tool design.

3. **Indentation-aware file reading** (Codex's `read_file` indentation mode) is a clever approach for code navigation that goes beyond simple line ranges.

4. **Progressive approval** (sandbox_permissions + justification parameters) is baked into tool schemas, not just the orchestration layer.

5. **Plan tool as first-class**: The update_plan tool with step/status tracking mirrors our own planning tool needs.

6. **Shell tool diversity**: Having both string-based and array-based shell execution, plus PTY support for interactive processes, covers a wide range of use cases.

7. **Reasoning persistence** via `previous_response_id` is critical for multi-turn agentic performance. Our architecture should support this pattern.
