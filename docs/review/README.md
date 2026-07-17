# Tech Lead Assessments

Periodic sustainability reviews of the Diligent codebase. Each file is named `<date>-<commit>[-scope].md`.

## Assessment Log

| File | Verdict | Scope | Phase / Notes |
|------|---------|-------|---------------|
| [2026-02-27-10f036c.md](2026-02-27-10f036c.md) | GREEN | Full project | Phase 4b complete (Skills + Slash Commands). First recorded assessment. |
| [2026-02-27-8bae17a.md](2026-02-27-8bae17a.md) | GREEN | Core only | Phase 4c complete (Print Mode + Collaboration Modes) + P0/P1 backlog items. Incremental improvement review. |
| [2026-02-28-aac82c7.md](2026-02-28-aac82c7.md) | YELLOW | Full project | Phase 4c + Gemini provider addition. Three type-sync points flagged as compounding risk. |
| [2026-03-02-8494f69-web.md](2026-03-02-8494f69-web.md) | YELLOW | packages/web | packages/web initial review (4 commits old). WebSocket reconnect loses thread context; type literals need deduplication. |
| [2026-03-02-594ac2a-web-frontend.md](2026-03-02-594ac2a-web-frontend.md) | GREEN-YELLOW | packages/web frontend | Same-day follow-up after remediation. tools.ts DRY + toSafeFallback bug fixed. App.tsx god-component risk flagged for Phase 5. |
| [2026-03-03-d0cf5e0.md](2026-03-03-d0cf5e0.md) | GREEN | Full project | All YELLOW items from aac82c7 resolved. Protocol package now single source of truth. Remaining risks: type duplication and hardcoded CLI fallback strings. |
| [2026-03-04-48d527c.md](2026-03-04-48d527c.md) | GREEN | Full project | Prior 5 priority actions unremediated (0/5). New finding: ModeKind/Mode naming split. EXPLORE.md nav migration positive. RPC raw strings in web compounding. |
| [2026-03-03-4209228.md](2026-03-03-4209228.md) | YELLOW | Full project | 0/11 previous findings remediated. New: notification handling duplication (CLI+Web), god components (app.ts 776 LOC). 795 tests passing. EXPLORE.md positive. |
| [2026-03-04-efe5e0a.md](2026-03-04-efe5e0a.md) | GREEN | Full project | All 5 priority actions from previous YELLOW resolved (100%). Notification adapter extracted, ProviderName unified, CLI decomposed, raw strings replaced. New: shadow protocol in rpc-bridge.ts, Desktop pickFolder bug. 808 tests passing. |
| [2026-03-05-e12100b.md](2026-03-05-e12100b.md) | GREEN | Full project | 3/3 Group 1 actions resolved (shadow protocol formalized in @diligent/protocol). Collab system, multi-client subscriptions, task tool removal, plan injection, ModelClass landed. 3,835 lines net. |
| [2026-03-05-d976272.md](2026-03-05-d976272.md) | GREEN | Full project | 3/3 Group 1 actions resolved. Parallel tool execution (D015), tool catalog/plugin system (P032), collab event unification, planner agent type. 6,637 lines net across 106 files. |
| [2026-03-06-a334453.md](2026-03-06-a334453.md) | GREEN | Full project | 3/3 Group 1 actions resolved (DILIGENT_VERSION, raw method strings, event-mapper). Thinking effort system (P035), image upload + vision support. 924 tests / 0 failures. |
| [2026-04-07-edd6ab9.md](2026-04-07-edd6ab9.md) | GREEN | Full project | 4/4 Priority Actions resolved (3rd consecutive 100%). Desktop promotion to apps/overdare-agent/, release pipeline, CI restoration. Infrastructure maturation period. |
| [2026-04-07-304eb9e.md](2026-04-07-304eb9e.md) | GREEN | Full project | 2/4 Priority Actions resolved (session debug cleanup, workspace verify). Consolidation micro-cycle. Novel: tool classification metadata belongs in protocol, not runtime. |
| [2026-04-08-fb16932.md](2026-04-08-fb16932.md) | GREEN | Full project | 3/3 Priority Actions resolved (stale re-exports, ProviderToolUseBlock docs, tool classification migration). VS Code extension landed as 4th client. Novel: notification-to-render pipeline needs shared intermediate representation. |
| [2026-04-09-8138452.md](2026-04-09-8138452.md) | GREEN | Full project | 1/3 Priority Actions resolved (shared reducer prototyped but unadopted). Plugin architecture validated by overdare feature delivery. Novel: write-only module anti-pattern — shared infra without consumers is a specification, not infrastructure. |
| [2026-04-13-12e41b4.md](2026-04-13-12e41b4.md) | GREEN | Full project | 3/5 Priority Actions resolved (shared reducer adopted in VS Code, request_user_input rendering, steering-queue tests). Novel: protocol reducer converging toward framework role but has no test suite. |
| [2026-04-14-fa2e8c7.md](2026-04-14-fa2e8c7.md) | GREEN | Full project | 3/4 Priority Actions resolved (conversation-reducer test suite, collab events in shared reducer, model/effort caching). Image attachment relative paths landed cleanly cross-cutting. Novel: reducer test suite validates today's behavior, not the convergence contract — cross-validation needed before Web adoption. |
| [2026-04-15-f94b52b.md](2026-04-15-f94b52b.md) | GREEN | Full project | 0/4 Priority Actions resolved (attention on Overdare plugin work). Plugin architecture validated by non-trivial studiorpc feature. Novel: plugin hooks are the untested half of the plugin SDK — zero consumers, zero e2e coverage, blocking semantics at risk. |
| [2026-07-17-f240e99b-core-llm.md](2026-07-17-f240e99b-core-llm.md) | GREEN | `packages/core/src/llm` | P080 follow-up. Prior internal refactors are complete; remaining priorities are async worker tracking, AI SDK abort termination, and provider-local decomposition. |
| [2026-07-17-ac2fca45-direct-provider-vercel-audit.md](2026-07-17-ac2fca45-direct-provider-vercel-audit.md) | YELLOW | Direct OpenAI, ChatGPT, and Anthropic providers | Keep direct implementations; correct current wire-contract gaps and remove hand-written or speculative plumbing. |
