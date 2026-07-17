// @summary RuntimeAgent — Agent subclass carrying an optional AgentRegistry for collab support

import type { AgentOptions } from "@diligent/core/agent";
import { Agent } from "@diligent/core/agent";
import type { Model, SystemSection } from "@diligent/core/provider-contract";
import type { Tool } from "@diligent/core/tool-contract";
// type-only import to avoid circular dependency: collab/registry → agent/runtime-agent → collab/registry
import type { AgentRegistry } from "../collab/registry";

export class RuntimeAgent extends Agent {
  readonly registry?: AgentRegistry;

  constructor(
    model: string | Model,
    systemPrompt: SystemSection[],
    tools: Tool[],
    opts?: AgentOptions,
    registry?: AgentRegistry,
  ) {
    super(model, systemPrompt, tools, opts);
    this.registry = registry;
  }
}
