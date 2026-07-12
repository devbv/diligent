# Subagent Settings

Subagent availability is configured under `agents.overrides` in global or project `config.jsonc`.

```jsonc
{
  "agents": {
    "overrides": {
      "explore": false,
      "code-reviewer": false
    }
  }
}
```

`general` is the required execution fallback. It is always available, even if a manually edited override sets it to `false`. `explore` and discovered custom agents are optional and default to enabled.

`agents.enabled` is unchanged: it only gates discovery of custom filesystem agents. Built-in roles remain available. Custom agents are discovered in the existing global, project, and configured-path precedence order.

Configuration follows normal layering. Project `agents.overrides` values take precedence over global values. The Web **Config → Subagents** panel writes global preferences only; project-controlled entries are shown read-only. The writer stores only `false` entries, so re-enabling an optional role removes its global override.

Changes apply when the next root or child agent is created. The Web panel reloads configuration after saving. In the TUI, edit config manually and run `/reload`. In-flight turns are not interrupted.
