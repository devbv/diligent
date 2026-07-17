# Tool settings

Diligent lets you control which built-in tools are available in a project and add trusted JavaScript plugin packages. Product builds can also ship bundled product tools that are registered by the packaged runtime itself.

## Where settings are stored

Tool settings are project-local in:

- `.diligent/config.jsonc`

Changes are applied on the next turn. Diligent does not hot-swap tool availability in the middle of a running turn.

## Trust model

Plugin packages run with full trust in the same process as Diligent.

That means a plugin can:

- read and write files the Diligent process can access
- run arbitrary JavaScript during package load and tool execution
- access environment variables available to the process
- make network requests if the runtime allows it

Only configure packages you already trust.

Bundled product tools run with the same trust level as the packaged runtime. They are not loaded from your project or home plugin folder, but their individual tools still appear in the tool catalog and use the same approval, rendering, and per-tool enablement paths as other tools.

## Built-in tools

Built-in tools are enabled by default.

When you disable a built-in tool in settings, Diligent stores only your intent override. For example:

```jsonc
{
  "tools": {
    "builtin": {
      "bash": false
    }
  }
}
```

Some built-ins are immutable and always stay enabled:

- `plan`
- `request_user_input`

These appear as locked in the UI and stay enabled even if config tries to disable them.

## Bundled product tools

Product variants can register first-party bundled tool providers in-process. For example, the OVERDARE packaged sidecar is assembled by `apps/overdare-ai-agent/sidecar`, imports `@diligent/web/server`, and injects OVERDARE-owned providers from `apps/overdare-ai-agent/sidecar/src/tools`.

Bundled product tools are different from external plugins:

- they ship in the runtime binary instead of being copied into `$HOME/.diligent/plugins` or `$HOME/.overdare/plugins`
- they do not require a `tools.plugins` config entry
- they can supersede legacy first-party plugin packages so stale copied plugin folders are ignored by the catalog
- their tool names, Zod schemas, approval prompts, user-input behavior, and render payloads should remain stable when migrated from a plugin
- trusted bundled tools may explicitly declare a provider-native model capability; their catalog name still controls settings, filtering, conflict resolution, and local dispatch

External user-installed plugins are still supported. Supersession only applies to package names declared by a bundled provider.

Provider-native model exposure is intentionally unavailable to external plugin SDK v1 tools. External plugins always advertise locally executable function tools, even if a JavaScript object includes an unknown `modelExposure` property. Adding third-party provider-native capabilities requires a versioned plugin API with validation and user-consent semantics.

## Plugin packages

Assume Diligent itself is already a built binary that you run inside your project.

For local custom plugins, use a fixed home-directory location such as:

- `$HOME/.diligent/plugins/<plugin-name>`

Diligent now resolves plugin packages in this order:

1. normal package import from the running project/environment
2. fallback to `$HOME/.diligent/plugins/<plugin-name>`

That means a prebuilt `diligent` binary can load a plugin from your home plugin folder even when the project did not install that package locally.

To add plugin tools:

1. Create or copy the plugin package under `$HOME/.diligent/plugins/<plugin-name>`.
2. Add the package name under `.diligent/config.jsonc` in either global or project config.
3. Start the next turn.

Diligent does not install npm packages for you in this phase.

If a package cannot be imported or validated, it remains visible in settings with a load error instead of crashing the server.

## Example config

```jsonc
{
  "tools": {
    "builtin": {
      "bash": false,
      "grep": false
    },
    "plugins": [
      {
        "package": "@acme/diligent-tools",
        "enabled": true,
        "tools": {
          "jira_comment": false
        }
      }
    ],
    "conflictPolicy": "error"
  }
}
```

Normalization rules:

- built-ins store only `false` overrides
- plugin packages stay present when you want them configured
- plugin tools store only `false` overrides
- default `conflictPolicy: "error"` is omitted when possible

## Conflict policy

Supported policies:

- `error`
- `builtin_wins`
- `plugin_wins`

Even with `plugin_wins`, immutable built-ins still win.

## Minimal plugin package contract

A plugin package must be importable by the running server process and export:

```ts
import { z } from "zod";

export const manifest = {
  name: "@acme/diligent-tools",
  apiVersion: "1.0",
  version: "0.1.0",
};

export async function createTools(ctx: { cwd: string }) {
  return [
    {
      name: "jira_comment",
      description: "Post a Jira comment",
      parameters: z.object({
        issueKey: z.string(),
        body: z.string(),
      }),
      async execute(input: { issueKey: string; body: string }) {
        return {
          output: `Would comment on ${input.issueKey}: ${input.body}`,
        };
      },
    },
  ];
}
```

## External-style example plugin

This repo includes a sample external plugin package at `examples/external-tool-plugin/`.

Treat that folder as if it were a separate repository published independently from Diligent.

- package: `example-tool-plugin`
- tool: `example_project_snapshot`
- behavior: read-only summary of the current project root

If you want to try it with a prebuilt `diligent` binary, copy this sample to your global plugin folder first:

```sh
mkdir -p $HOME/.diligent/plugins
cp -R /absolute/path/to/diligent/examples/external-tool-plugin $HOME/.diligent/plugins/example-tool-plugin
```

Then enable it in global config `~/.diligent/config.jsonc` or in the target project's `.diligent/config.jsonc`:

```jsonc
{
  "tools": {
    "plugins": [{ "package": "example-tool-plugin", "enabled": true }]
  }
}
```

If you place that entry in `~/.diligent/config.jsonc`, the plugin is available by default across projects. A project-level `.diligent/config.jsonc` can still override tool settings as usual.

After the next turn starts, ask Diligent to use `example_project_snapshot`.

## Why a plugin may fail to load

Common reasons:

- the package is not installed in the project
- `manifest.name` does not match the configured package name
- `manifest.apiVersion` is incompatible
- `createTools()` throws
- `createTools()` does not return an array
- the plugin returns invalid tools
- the plugin returns duplicate tool names

## Current limitations

This phase does not include:

- plugin sandboxing or permissions
- automatic package installation
- plugin discovery from the filesystem or npm registry
- hot reload for plugin code
- lifecycle hooks around tool execution
