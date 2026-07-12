# Product experiments

Product hosts can advertise experimental capability groups to the shared runtime and Web client. A group owns all
skills and tools named by its definition, so one setting is the source of truth for the complete capability.

The generic Diligent host injects no definitions. In that case the Web Config panel has no Experiments section.
OVERDARE injects its definitions from `apps/overdare-ai-agent/sidecar/src/experiments.ts`.

Experiment overrides are stored in the active global namespace config:

```jsonc
{
  "experiments": {
    "overrides": {
      "procedural": true
    }
  }
}
```

Missing overrides use the product definition's `defaultEnabled` value. Changes apply on the next turn and rebuild the
active skill/tool surface together. Product MCP entrypoints must resolve the same definitions and config so an OFF
experiment is not exposed through a second client surface.
