# diligent

yet the most diligent coding agent

## Principles

**Transparency over complexity** — LLMs are non-deterministic, making agent behavior inherently unpredictable. Without transparency, development becomes increasingly difficult. Keep things simple so every layer can be debugged, experimented with, measured, verified, and improved — continuously.

**Project-centric** — Conversations, knowledge, and code live together as one project. The `.diligent/` directory is the boundary — sessions are JSONL files, knowledge is local, config is checked in. Everything the agent knew, decided, and did is right there in the repo. Sharing, debugging, and reproducing become trivial. Because everything lives in the project, continuity is inspectable.

**Effortless continuity** — Nobody should think about context management. Compaction, knowledge recall, and session history happen behind the scenes. One session can run forever — pick up where you left off, or start fresh. Because continuity is effortless, the project stays honest.

**When everything is "important," nothing is** — The agent harness should not try to do everything. Find the few moves that truly matter.

## Getting Started

Requires [Bun](https://bun.sh) v1.2+ and an API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`).

```sh
git clone https://github.com/anthropics/diligent.git && cd diligent
bun install
export ANTHROPIC_API_KEY="sk-..."
bun run packages/cli/src/index.ts
```

Resume the last session with `--continue`, or list past sessions with `--list`.
