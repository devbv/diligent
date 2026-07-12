# Skill settings

Diligent discovers local skills from the project, global user directory, and optional paths in `config.jsonc`. Every discovered skill is enabled by default. You can disable individual skills with `skills.overrides` without deleting the skill files.

## Discovery order

Skills are discovered in this order, with the first skill name winning when multiple files define the same name:

1. Project: `.diligent/skills/`
2. Global: `~/.diligent/skills/`
3. Configured paths: `skills.paths[]`

The Web settings list keeps the full discovered catalog visible, even when a skill is disabled, so it can be turned back on later.

## Config shape

```jsonc
{
  "skills": {
    // Master switch. Defaults to true.
    "enabled": true,

    // Extra directories to scan after project and global skills.
    "paths": ["/shared/team-skills"],

    // Per-skill preferences keyed by resolved skill name.
    // Missing means enabled.
    "overrides": {
      "tech-lead": false
    }
  }
}
```

`skills.enabled: false` is a master availability gate. Diligent still discovers skills and shows them in settings, but no skill is exposed to the system prompt, `skill` tool, agent validation, or slash-command skill names until the master switch is enabled again.

`skills.overrides` is an individual preference map. Missing entries mean ON. The Web writer stores only explicit `false` entries in the global config; setting a global skill back to ON removes that key.

## Layering and precedence

Config layers are merged as global `<` project. That means:

- global `skills.paths` and `skills.enabled` can be replaced by project config through normal config merging;
- `skills.overrides` deep-merges by skill name;
- a project `skills.overrides.<name>` entry controls that skill's effective value over any global entry;
- unrelated global override keys remain effective when a project config controls a different skill.

The Web Config UI writes only to `~/.diligent/config.jsonc`. If a project config contains an explicit override for a skill, Web reports it as project-controlled and treats it as read-only.

## Web workflow

Open **Config → Skills** to see discovered skills, their source, global preference, and effective availability. Saving applies to the global config and takes effect on the next agent build. In-flight turns are not interrupted. Dynamic slash-command suggestions are refreshed from the save response.

## TUI workflow

The TUI uses the same runtime resolution. Edit global or project `config.jsonc` manually, then use the existing `/reload` flow so the next turn rebuilds agents with the updated active skill set.

## Frontmatter distinction

`disable-model-invocation` in `SKILL.md` is separate from config availability. A config-disabled skill is unavailable entirely. A config-enabled skill with `disable-model-invocation: true` keeps the existing behavior: it is not listed for autonomous model invocation, but it can still be loaded through explicit skill mechanisms where supported.
