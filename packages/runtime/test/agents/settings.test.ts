// @summary Tests layered subagent catalog setting resolution.

import { describe, expect, it } from "bun:test";
import type { ResolvedAgentDefinition } from "../../src/agent/resolved-agent";
import { filterAvailableAgentDefinitions, resolveSubagentStates, type SubagentCatalogEntry } from "../../src/agents";

function entry(name: string, required = false): SubagentCatalogEntry {
  return {
    definition: {
      name,
      description: `${name} description`,
      source: name === "general" || name === "explore" ? "builtin" : "user",
      readonly: name === "explore",
    } as ResolvedAgentDefinition,
    source: name === "general" || name === "explore" ? "builtin" : "project",
    required,
  };
}

describe("resolveSubagentStates", () => {
  it("keeps general required while optional roles default to enabled", () => {
    const states = resolveSubagentStates([entry("general", true), entry("explore"), entry("reviewer")], undefined, {});

    expect(states.map((state) => [state.definition.name, state.available, state.controlledBy, state.reason])).toEqual([
      ["general", true, "required", "required_builtin"],
      ["explore", true, "default", "enabled"],
      ["reviewer", true, "default", "enabled"],
    ]);
  });

  it("honors layered optional overrides but never disables general", () => {
    const states = resolveSubagentStates(
      [entry("general", true), entry("explore"), entry("reviewer")],
      { overrides: { general: false, explore: true, reviewer: false } },
      {
        global: { agents: { overrides: { general: false, explore: false, reviewer: false } } },
        project: { agents: { overrides: { explore: true } } },
      },
    );

    expect(
      states.map((state) => [state.definition.name, state.globalEnabled, state.effectiveEnabled, state.controlledBy]),
    ).toEqual([
      ["general", true, true, "required"],
      ["explore", false, true, "project"],
      ["reviewer", false, false, "global"],
    ]);
    expect(filterAvailableAgentDefinitions(states).map((agent) => agent.name)).toEqual(["general", "explore"]);
  });
});
