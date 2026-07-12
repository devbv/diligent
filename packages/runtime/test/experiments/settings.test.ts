// @summary Tests product experiment resolution and coupled skill/tool gating.

import { describe, expect, it } from "bun:test";
import { resolveExperimentGates, resolveExperimentStates } from "../../src/experiments";

const definitions = [
  {
    id: "procedural",
    title: "Procedural generation",
    description: "Generate scenes from reusable Luau recipes.",
    defaultEnabled: false,
    toolNames: ["studiorpc_procedural_run"],
    skillNames: ["procedural-luau-json"],
  },
];

describe("experiment settings", () => {
  it("uses product defaults and applies one override to both gates", () => {
    expect(resolveExperimentStates(definitions, undefined)[0]?.enabled).toBe(false);

    const enabled = resolveExperimentGates(resolveExperimentStates(definitions, { procedural: true }));
    expect(enabled).toEqual({ disabledToolNames: new Set(), disabledSkillNames: new Set() });

    const disabled = resolveExperimentGates(resolveExperimentStates(definitions, { procedural: false }));
    expect(disabled.disabledToolNames).toEqual(new Set(["studiorpc_procedural_run"]));
    expect(disabled.disabledSkillNames).toEqual(new Set(["procedural-luau-json"]));
  });
});
