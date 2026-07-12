// @summary Tests for layered skill setting resolution.

import { describe, expect, it } from "bun:test";
import type { SkillMetadata } from "../../src/skills";
import { filterAvailableSkills, resolveSkillStates, resolveSkillsEnabledControl } from "../../src/skills";

function skill(name: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source: "project",
    disableModelInvocation: false,
  };
}

describe("resolveSkillStates", () => {
  it("enables unspecified discovered skills by default", () => {
    const states = resolveSkillStates([skill("write-plan")], undefined, {});

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      globalEnabled: true,
      effectiveEnabled: true,
      available: true,
      controlledBy: "default",
      reason: "enabled",
    });
    expect(filterAvailableSkills(states).map((s) => s.name)).toEqual(["write-plan"]);
  });

  it("reports global false, project overrides, and available skills in discovery order", () => {
    const states = resolveSkillStates(
      [skill("alpha"), skill("beta"), skill("gamma")],
      { overrides: { alpha: true, beta: false, gamma: false } },
      {
        global: { skills: { overrides: { alpha: false, beta: false } } },
        project: { skills: { overrides: { alpha: true, gamma: false } } },
      },
    );

    expect(
      states.map((state) => [state.skill.name, state.globalEnabled, state.effectiveEnabled, state.controlledBy]),
    ).toEqual([
      ["alpha", false, true, "project"],
      ["beta", false, false, "global"],
      ["gamma", true, false, "project"],
    ]);
    expect(filterAvailableSkills(states).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("master switch makes every skill unavailable without changing individual preferences", () => {
    const states = resolveSkillStates(
      [skill("alpha"), skill("beta")],
      { enabled: false, overrides: { beta: false } },
      { global: { skills: { enabled: false, overrides: { beta: false } } } },
    );

    expect(resolveSkillsEnabledControl({ global: { skills: { enabled: false } } })).toBe("global");
    expect(states.map((state) => [state.skill.name, state.effectiveEnabled, state.available, state.reason])).toEqual([
      ["alpha", true, false, "skills_disabled"],
      ["beta", false, false, "skills_disabled"],
    ]);
  });
});
