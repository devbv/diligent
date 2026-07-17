<p align="center">
  <img src="assets/icon.svg" width="120" height="120" />
</p>

# diligent

yet the most diligent coding agent

## Principles

**Effortless continuity** — Nobody should think about context management. Compaction, knowledge recall, and session history happen behind the scenes. One session can run forever — pick up where you left off, or start fresh. The agent never forgets what you want to build. Because continuity is effortless, the project stays honest.

**Project-centric** — Conversations, knowledge, and code live together as one project. The `.diligent/` directory is the boundary — sessions are JSONL files, knowledge is local, config is checked in. Everything the agent knew, decided, and did is right there in the repo. Sharing, debugging, and reproducing become trivial. Because everything lives in the project, continuity is inspectable.

**Transparency over complexity** — LLMs are non-deterministic, making agent behavior inherently unpredictable. Without transparency, development becomes increasingly difficult. Keep things simple so every layer can be debugged, experimented with, measured, verified, and improved — continuously.

## Getting Started

Requires [Bun](https://bun.sh) v1.2+.

```sh
git clone https://github.com/overdare/diligent.git && cd diligent
bun install
make dev
```

## Development Surfaces

- `make dev` — run the CLI/TUI
- `make release-local` — build and install `diligent` into your user bin directory
- `make web-dev` — run the Web CLI locally: backend (:7433) + Vite frontend (:5174)
- `make web-start` — run the web backend server
- `make debug-dev` — run the debug viewer

`make release-local` installs to a standard user bin location: it uses `BIN_DIR` when provided, otherwise `XDG_BIN_DIR`, then prefers `~/.local/bin` or `~/bin` if either is already on `PATH`, and finally falls back to `~/.local/bin`. You can override the destination with `BIN_DIR=/your/bin make release-local`.

## Workspace Overview

- `packages/core` — reusable agent engine primitives
- `packages/runtime` — runtime assembly: app server, sessions, tools, config, knowledge, skills, collaboration
- `packages/protocol` — shared frontend/backend protocol schemas and models
- `packages/plugin-sdk` — public SDK for external tool plugins
- `packages/cli` — CLI entrypoint and TUI client
- `packages/web` — Bun web server and React web client
- `apps/overdare-ai-agent` — terminal-only wrapper for runtime update and webserver launch
- `packages/debug-viewer` — viewer for inspecting `.diligent/` project data
- `packages/e2e` — end-to-end protocol/runtime tests
- `packages/evals` — live-model behavioral evaluations for core capabilities

## Packaged OVERDARE storage namespace

Packaged OVERDARE CLI flows use the `overdare` storage namespace at launcher runtime. That switches packaged state from `~/.diligent` / `./.diligent` to `~/.overdare` / `./.overdare`. The launcher performs a one-time migration from legacy `.diligent` only when the target namespace does not yet exist. Ordinary non-packaged source checkout workflows remain on `.diligent` unless the packaged namespace env is present.

## Commit and PR title convention

Commit and PR titles are enforced with the same format:

`<type>(<scope>): <summary>`

- Allowed `type`: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- `scope`: lowercase letters, numbers, and `-`
- `summary`: short, clear, and up to 72 characters

Examples:

- `feat(runtime): add session append batching`
- `fix(cli): prevent duplicate redraw on resize`
- `chore(ci): bump github actions versions`

## Tool settings

Diligent supports project-local tool settings for:

- enabling or disabling built-in tools
- adding trusted JavaScript plugin packages
- enabling or disabling whole plugin packages or individual plugin tools

Use the Tool settings entry in Web or `/tools` in TUI.

See [`docs/guide/tool-settings.md`](docs/guide/tool-settings.md) for the trust model, config format, plugin contract, the external-style sample plugin at `thirdparty/examples/external-tool-plugin/`, and current limitations.

## References

- [codex](https://github.com/openai/codex) — OpenAI Codex CLI
- [pi-mono](https://github.com/badlogic/pi-mono) — badlogic's pi-mono
- [opencode](https://github.com/anomalyco/opencode) — Anomaly's opencode
