// @summary Tests for agent mode definitions and tool allowlists
import { describe, expect, test } from "bun:test";
import { MODE_SYSTEM_PROMPT_SUFFIXES } from "../../src/agent/mode";

describe("MODE_SYSTEM_PROMPT_SUFFIXES", () => {
  test("default mode has empty suffix", () => {
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.default).toBe("");
  });

  test("execute mode prompt instructs agents to wait for running sub-agents before yielding", () => {
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.execute).toContain("wait for them before yielding");
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.execute).toContain(
      "your primary role becomes coordinating them until they finish",
    );
  });

  test("execute mode prompt forbids request_user_input and user questions", () => {
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.execute).toContain("You cannot use request_user_input in Execute Mode");
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.execute).toContain("Do not ask the user questions");
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.execute).toContain("choose a reasonable default");
  });

  test("plan mode prompt instructs agents to wait for running explore agents before yielding", () => {
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.plan).toContain("wait for them before yielding");
  });

  test("plan mode prompt says visible tools are not mutation permission", () => {
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.plan).toContain("Tool availability is **not** permission to mutate");
    expect(MODE_SYSTEM_PROMPT_SUFFIXES.plan).toContain("do not use any visible tool in a way that causes mutation");
  });
});
