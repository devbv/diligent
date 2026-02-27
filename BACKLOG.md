# Backlog

## Pending

### P0 — Immediate (stability & security)

- [ ] **Implement loop detection** — Track tool call signatures (name + args hash), detect repeating patterns (length 1/2/3) within a configurable window (default 10). Inject warning as SteeringTurn when detected. Currently only maxTurns hard stop exists. Reference: attractor spec §2.10. ~100 lines estimated. (added: 2026-02-27)
- [ ] **Add environment variable filtering to bash tool** — Filter `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` patterns by default before passing env to child processes. Currently no filtering — API keys can leak to LLM via tool output. Reference: attractor spec §4.2. ~30 lines estimated. (added: 2026-02-27)

### P1 — High (core loop quality)

- [ ] **Fix output truncation order and add head_tail mode** — Change to char-based first, then line-based (currently reversed — vulnerable to pathological cases like 2-line 10MB CSV). Add head_tail split mode that preserves both beginning and end of output. Add explicit WARNING marker in truncated output so LLM knows data is missing. Reference: attractor spec §5.1-5.3. (added: 2026-02-27)
- [ ] **Implement per-tool output limits** — Different char limits per tool (read_file: 50k, shell: 30k, grep: 20k, glob: 20k, edit: 10k, write: 1k) instead of current uniform 50KB/2000 lines for all tools. Configurable via SessionConfig. Reference: attractor spec §5.2. (added: 2026-02-27)
- [ ] **Add steering queue to agent loop** — Implement `steer()` and `follow_up()` APIs on SessionManager. Add `drain_steering()` before/after LLM calls. New SteeringTurn type in session history, converted to user-role messages for LLM. Key enabler for library-first usage and mid-task redirection by host applications. Reference: attractor spec §2.5-2.6. (added: 2026-02-27)

### P2 — Medium (future capabilities)

- [ ] **Add context budget management for compaction** — Context compaction fails when the context window is completely full (no room to run the compaction itself). The agent needs to reserve ~20% of the context window as headroom so compaction can always be triggered before it's too late. Investigate the right threshold and implement a proactive compaction strategy. (added: 2026-02-25)
- [ ] **Implement background async piggyback pattern** — The agent loop needs a mechanism to inject asynchronously-produced results (LSP diagnostics, file watcher events, background indexer output) into the next turn's context at natural breakpoints. The pattern is well-documented in research (codex-rs `TurnMetadataState`, pi-agent `getSteeringMessages`, opencode DB re-read) but not implemented or planned. Generalize the existing `getSteeringMessages()` callback design (D011) to a `getPendingInjections()` that drains both user steering messages and background results. See: `docs/research/layers/01-agent-loop.md` § Background Async Piggyback Pattern. (added: 2026-02-25)

### P3 — Low (opportunistic)

- [ ] **Sync debug-viewer shared types when Phase 3 implements session persistence** — `packages/debug-viewer/src/shared/types.ts` duplicates core types by convention (DV-01). When Phase 3 adds session writer and potentially new fields (D086 `itemId`, expanded `ApprovalResponse`, etc.), manually sync viewer types. D086's serialization contract (`JSON.parse(JSON.stringify())` roundtrip tests) is the reference for format stability. Include this as a checklist item in the Phase 3 implementation plan (`docs/plan/impl/`). (added: 2026-02-25)

## Done
