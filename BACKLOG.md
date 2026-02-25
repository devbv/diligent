# Backlog

## Pending

- [ ] **Add context budget management for compaction** — Context compaction fails when the context window is completely full (no room to run the compaction itself). The agent needs to reserve ~20% of the context window as headroom so compaction can always be triggered before it's too late. Investigate the right threshold and implement a proactive compaction strategy. (added: 2026-02-25)
- [ ] **Implement background async piggyback pattern** — The agent loop needs a mechanism to inject asynchronously-produced results (LSP diagnostics, file watcher events, background indexer output) into the next turn's context at natural breakpoints. The pattern is well-documented in research (codex-rs `TurnMetadataState`, pi-agent `getSteeringMessages`, opencode DB re-read) but not implemented or planned. Generalize the existing `getSteeringMessages()` callback design (D011) to a `getPendingInjections()` that drains both user steering messages and background results. See: `research/layers/01-agent-loop.md` § Background Async Piggyback Pattern. (added: 2026-02-25)
- [ ] **Sync debug-viewer shared types when Phase 3 implements session persistence** — `packages/debug-viewer/src/shared/types.ts` duplicates core types by convention (DV-01). When Phase 3 adds session writer and potentially new fields (D086 `itemId`, expanded `ApprovalResponse`, etc.), manually sync viewer types. D086's serialization contract (`JSON.parse(JSON.stringify())` roundtrip tests) is the reference for format stability. Include this as a checklist item in the Phase 3 implementation plan (`plan/impl/`). (added: 2026-02-25)

## Done
