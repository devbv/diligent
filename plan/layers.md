# Layer Definitions and Order

## Current Layer List

| Layer | Name | One-Line Definition | Status |
|---|---|---|---|
| L0 | REPL Loop | Basic stdin/stdout conversation loop with LLM streaming | Research complete, implementation planned |
| L1 | Tool System | Framework for defining, registering, and invoking tools within the agent loop | Research complete |
| L2 | Core Tools | Built-in tools: file read/write/edit, bash execution, glob, grep, ls | Research complete |
| L3 | Approval & Sandbox | Permission model and sandboxed execution for tool calls | Research pending |
| L4 | Config System | Hierarchical configuration (global, project, session) | Research pending |
| L5 | Session & Persistence | Conversation history, session management, context compression | Research pending |
| L6 | TUI | Terminal UI with rich rendering (markdown, syntax highlight, spinners) | Research pending |
| L7 | Slash Commands & Skills | User-invocable commands and extensible skill system | Research pending |
| L8 | MCP | Model Context Protocol server/client integration | Research pending |
| L9 | Multi-Agent | Sub-agent spawning, parallel execution, task delegation | Research pending |

## Dependencies

```
L0 ← L1 ← L2
          ← L3 (approval depends on tool system; L1 includes approve() hook for L3)
L0 ← L4 (config can be loaded early)
L0 ← L5 (session wraps the loop)
L1 ← L6 (TUI needs to render tool results)
L1 ← L7 (commands are a form of tool)
L1 ← L8 (MCP extends the tool system)
L1 ← L9 (multi-agent uses tool system for delegation)
```

Note: Dependencies flow right-to-left (← means "depends on"). L4 and L5 are somewhat independent and could be introduced at various points.

## Research Progress

| Round | Layers | Status | Date |
|---|---|---|---|
| 0 | L0 (REPL Loop) | Complete | 2026-02-22 |
| 1 | L1 (Tool System) + L2 (Core Tools) | Complete | 2026-02-23 |
| 2 | L3 + L4 + L5 | Next | — |
| 3 | L6 + L7 + L8 + L9 | Waiting | — |

## Change History

| Date | Change | Reason |
|---|---|---|
| 2026-02-22 | Initial layer list created | Based on decomposition of coding agent capabilities, informed by codex-rs/pi-agent/opencode analysis |
| 2026-02-23 | L1+L2 research complete, 10 new decisions (D005-D014) | Round 1 synthesis: Zod schemas, sequential execution, approval hook placeholder, 7 core tools, exact text replacement edit strategy |
