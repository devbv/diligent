---
name: agent-guide
description: Explains how to use and configure the OVERDARE AI agent — setting up MCP servers, defining custom sub-agents, authoring Skills, and the config file layers. Use this skill when the user asks how the agent works or how to set something up, e.g. "how do I add an MCP server?", "how do I create a custom agent?", "how do I write a skill?", "what config options are there?", "MCP 설정하는 법", "에이전트 만드는 법", "스킬 작성법", or any general "how do I use this agent?" question. Not for building OVERDARE Studio worlds — only for explaining/guiding the agent's own configuration and usage.
---

# Agent Usage Guide

Help the user set up and configure the OVERDARE AI agent. Answer with the specific facts below; do not guess. When the user asks about one area (MCP, agents, skills, config), answer that area first, then offer the adjacent next step.

Match the user's language (Korean in, Korean out). Show real, copy-pasteable snippets.

## Config layers

The agent reads JSONC config from two layers, deep-merged (project overrides global):

- Global: `~/.overdare/config.jsonc`
- Project: `.overdare/config.jsonc`

Skills, agents, and MCP servers follow the same global + project discovery model. Secrets use `{env:VAR}` placeholders so they stay out of the committed file. Reload or restart the agent after editing config or adding/removing skills, agents, or servers.

---

## 1. MCP servers

Connect external [Model Context Protocol](https://modelcontextprotocol.io) servers and expose each server's tools to the agent as normal tools.

Declare servers under a top-level `mcpServers` map. Two transports:

```jsonc
{
  "mcpServers": {
    // Local subprocess (stdio)
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
    },
    // Remote (Streamable HTTP, falls back to SSE)
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
    }
  }
}
```

**stdio fields:** `command` (required), `args`, `env` (overlaid on a curated safe set — the full parent env is not forwarded), `cwd`.

**HTTP fields:** `url` (required), `type` (`"http"` default or `"sse"`), `headers`, `bearerTokenEnvVar`, `oauth`.

**Shared fields:** `enabled` (default true), `tools` (per-tool toggle map like `{ "dangerous_tool": false }`), `startupTimeoutMs` (30000), `toolTimeoutMs` (120000).

**Tool naming:** server tools appear as `mcp__<server>__<tool>`.

**OAuth servers** (e.g. Atlassian): connecting never opens a browser automatically. If a server needs auth it shows as `needs_auth`; use the `/mcp login <server>` command to authorize, `/mcp logout <server>` to clear, `/mcp list` to see status.

**Tool loading** (keeps context flat as servers grow) — top-level `mcp` object:

```jsonc
{ "mcp": { "toolLoading": "auto", "lazyThreshold": 20 } }
```

`auto` (default) is eager until the exposed tool count exceeds `lazyThreshold`, then switches to two proxy tools (`mcp_search_tools` + `mcp_run_tool`). Force with `"eager"` or `"lazy"`.

---

## 2. Custom sub-agents

Sub-agents are specialized workers the model can spawn via the `spawn_agent` tool. Built-ins include `general`, `explore`, and any custom ones you define.

**Location** (kebab-case dir, `AGENT.md` inside):

- Project: `.overdare/agents/<name>/AGENT.md`
- Global: `~/.overdare/agents/<name>/AGENT.md`

The agent `name` must match its directory name.

**Format** — YAML frontmatter + Markdown body (the body is the agent's system prompt):

```markdown
---
name: code-reviewer
description: Reviews code changes for correctness, maintainability, and risk
tools: read, glob, grep
model_class: general
---

You are a focused code review agent.

## What to optimize for
- Correctness and regression risk
- Missing validation or error handling
...
```

**Frontmatter fields:**

- `name` (required, kebab-case, matches dir).
- `description` (required) — tells the model when to spawn this agent.
- `tools` (optional) — comma-separated or YAML list of tool names to restrict the agent to. Omit to inherit the default set.
- `model_class` (optional) — `pro`, `general`, or `lite`.

Write the body as a real worker brief: role, what to optimize for, how to work, output style.

---

## 3. Skills

Skills are on-demand instruction sets the model loads when a task matches their description (this guide is itself a skill).

**Location** (kebab-case dir, `SKILL.md` inside; a flat `<name>.md` also works):

- Project: `.overdare/skills/<name>/SKILL.md`
- Global: `~/.overdare/skills/<name>/SKILL.md`

**Format** — YAML frontmatter + Markdown body (the instructions):

```markdown
---
name: my-skill
description: One or two sentences on WHAT it does and WHEN to use it, including trigger phrases the user might say. This is the only thing the model sees before loading, so make it precise. (max 1024 chars)
---

# My Skill

Step-by-step instructions, workflow, examples, and rules the model should
follow once this skill is loaded. Reference other files with paths relative
to this skill's directory; the model reads only what it needs.
```

**Frontmatter fields:**

- `name` (required, kebab-case, ≤64 chars).
- `description` (required, ≤1024 chars) — the trigger. Include concrete phrases ("when the user says X") so autonomous invocation is reliable.
- `disable-model-invocation` (optional bool) — set `true` to make the skill user-invoke-only (never auto-triggered by the model).

**How skills run:** the model calls the `skill` tool with `{"name":"<name>"}`, which loads the body into context. Keep the body focused; put large references in sibling files and load them lazily.

---

## Answering checklist

1. Identify which area the user needs (MCP / agent / skill / config).
2. Give the exact file location + a minimal working snippet.
3. Mention `{env:VAR}` for any secret.
4. Remind them to reload/restart the agent after changes.
5. Offer the natural next step (e.g. after adding an MCP server, how to check its status).
