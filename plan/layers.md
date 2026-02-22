# Layer Definitions and Order

## Current Layer List

| Layer | Name | One-Line Definition | Status |
|---|---|---|---|
| L0 | REPL Loop | Basic stdin/stdout conversation loop with LLM streaming | Research complete (re-researched), decisions D001-D011 |
| L1 | Tool System | Framework for defining, registering, and invoking tools within the agent loop | Research complete (re-researched), decisions D012-D016 |
| L2 | Core Tools | Built-in tools: file read/write/edit, bash execution, glob, grep, ls | Research complete (re-researched), decisions D017-D026 |
| L3 | Approval & Sandbox | Permission model and sandboxed execution for tool calls | Research complete, decisions D027-D031 |
| L4 | Config System | Hierarchical configuration (global, project, CLI) | Research complete, decisions D032-D035 |
| L5 | Session & Persistence | Conversation history, session management, context compression | Research complete, decisions D036-D043 |
| L6 | TUI | Terminal UI with rich rendering (markdown, syntax highlight, spinners) | Research complete, decisions D045-D050 |
| L7 | Slash Commands & Skills | User-invocable commands and extensible skill system | Research complete, decisions D051-D055 |
| L8 | MCP | Model Context Protocol server/client integration | Research complete, decisions D056-D061 |
| L9 | Multi-Agent | Sub-agent spawning, parallel execution, task delegation | Research complete, decisions D062-D066 |

## Dependencies

```
L0 ← L1 ← L2
          ← L3 (approval depends on tool system; L1 includes approve() hook for L3)
L0 ← L4 (config can be loaded early; MCP/agent config lives here)
L0 ← L5 (session wraps the loop)
L1 ← L6 (TUI needs to render tool results)
L1 ← L7 (commands are a form of tool)
L1 ← L8 (MCP tools register in tool registry; config from L4)
     L3 ← L8 (MCP tools go through same permission system)
     L4 ← L8 (MCP server config in JSONC config)
L1 ← L9 (task tool registers in tool registry)
     L3 ← L9 (sub-agent permission isolation uses approval system)
     L5 ← L9 (sub-agents create child sessions)
```

Note: Dependencies flow right-to-left (← means "depends on"). L4 and L5 are somewhat independent and could be introduced at various points. L8 and L9 have the deepest dependency chains, confirming they should be implemented last.

## Research Progress

| Round | Layers | Status | Date |
|---|---|---|---|
| 0 | L0 (REPL Loop) | Complete (re-researched) | 2026-02-23 |
| 1 | L1 (Tool System) + L2 (Core Tools) | Complete (re-researched) | 2026-02-23 |
| 2 | L3 + L4 + L5 | Complete | 2026-02-23 |
| 3 | L6 (TUI) + L7 (Slash Commands & Skills) | Complete | 2026-02-23 |
| 4 | L8 (MCP) + L9 (Multi-Agent) | Complete | 2026-02-23 |
| — | Full Review Pass (3g) | Complete | 2026-02-23 |
| — | Outer Loop Evaluation | Converged (D076) | 2026-02-23 |

76 decisions total (D001-D076). **RESEARCH CONVERGED — ready for architecture design.**

## Change History

| Date | Change | Reason |
|---|---|---|
| 2026-02-22 | Initial layer list created | Based on decomposition of coding agent capabilities, informed by codex-rs/pi-agent/opencode analysis |
| 2026-02-23 | L1+L2 research complete, 10 new decisions (D005-D014) | Round 1 synthesis: Zod schemas, sequential execution, approval hook placeholder, 7 core tools, exact text replacement edit strategy |
| 2026-02-23 | Full re-research from Round 0 | Deep-dive research with thorough code analysis. L0 decisions refined: D001-D004 confirmed, 7 new decisions D005-D011 (unified messages, JSONL persistence, EventStream, TurnContext/SessionState separation, AbortController, retry strategy, deferred items). Round 1 decisions renumbered D012-D021. |
| 2026-02-23 | Round 1 re-research complete | L1+L2 deep-dive confirmed D012-D021. 5 new decisions D022-D026 (ripgrep for glob, binary detection, edit strategies, auto-truncation, deferred items). Layer order unchanged. |
| 2026-02-23 | Round 2 research complete | L3+L4+L5 deep-dive: 18 new decisions D027-D044. L3: rule-based approval with wildcards, ctx.ask() pattern, once/always/reject responses, no OS sandbox at MVP, doom loop detection. L4: JSONC+Zod, 3-layer hierarchy, CLAUDE.md discovery. L5: JSONL+tree confirmed, LLM compaction with iterative summaries, file operation tracking, session listing/resume/fork, deferred persistence. Layer order unchanged — L3/L4/L5 remain independent of each other as expected. |
| 2026-02-23 | Round 3 research complete | L6+L7 deep-dive: 11 new decisions D045-D055. L6: inline ANSI TUI (no alternate screen), no server between TUI and core (resolves D011), marked for markdown, raw mode with Kitty protocol, braille spinners, overlay system. L7: registry-based slash commands, SKILL.md with frontmatter (resolves D044), implicit skill invocation, Interactive+Print modes. Round grouping updated: Round 3 is L6+L7 only, Round 4 is L8+L9. Layer order unchanged. |
| 2026-02-23 | Round 4 research complete (FINAL) | L8+L9 deep-dive: 11 new decisions D056-D066. L8: official MCP SDK, stdio+StreamableHTTP transport, discriminated config union, MCP tools as regular registry entries, tools-only at MVP. L9: TaskTool pattern with child sessions, code-defined agent types with config override, explicit deny permission isolation, wrapped text results. Full review pass (3g) completed: layer decomposition validated (D067), cross-layer consistency confirmed (D068), implementation order recommended (D069). ALL RESEARCH COMPLETE. |
| 2026-02-23 | Outer loop evaluation: research converged | Full audit of 103 open questions across 10 layers: 94 resolved by D001-D069, 9 gaps filled by D070-D075. D076 declares convergence. Layer decomposition, boundaries, order, and round grouping all stable. No Cycle 2 needed. |
