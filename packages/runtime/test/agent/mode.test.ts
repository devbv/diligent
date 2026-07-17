// @summary Tests for agent mode definitions and tool allowlists
import { describe, expect, test } from "bun:test";
import type { Tool } from "@diligent/core/tool-contract";
import {
  EXECUTE_MODE_DISALLOWED_TOOLS,
  MODE_SYSTEM_PROMPT_SUFFIXES,
  PLAN_MODE_DISALLOWED_TOOLS,
} from "../../src/agent/mode";
import { filterToolsByMode } from "../../src/app-server/factory";

function tool(name: string): Tool {
  return { name, description: name, parameters: {} as never, execute: async () => ({ output: "" }) };
}

describe("mode tool filtering", () => {
  test("plan mode excludes only explicitly disallowed tools", () => {
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("bash")).toBe(true);
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("write")).toBe(true);
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("apply_patch")).toBe(true);
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("update_knowledge")).toBe(true);
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("web_action")).toBe(false);
    expect(PLAN_MODE_DISALLOWED_TOOLS.has("mcp_run_tool")).toBe(false);

    const filtered = filterToolsByMode("plan", [
      tool("read"),
      tool("web_action"),
      tool("overdaresearch"),
      tool("mcp_run_tool"),
      tool("bash"),
      tool("write"),
      tool("update_knowledge"),
    ]).map((entry) => entry.name);

    expect(filtered).toEqual(["read", "web_action", "overdaresearch", "mcp_run_tool"]);
  });

  test("execute mode removes request_user_input", () => {
    expect(EXECUTE_MODE_DISALLOWED_TOOLS.has("request_user_input")).toBe(true);

    const filtered = filterToolsByMode("execute", [
      tool("request_user_input"),
      tool("read"),
      tool("bash"),
      tool("overdaresearch"),
    ]).map((entry) => entry.name);

    expect(filtered).toEqual(["read", "bash", "overdaresearch"]);
  });

  test("default mode keeps all tools", () => {
    const filtered = filterToolsByMode("default", [tool("request_user_input"), tool("bash")]).map(
      (entry) => entry.name,
    );
    expect(filtered).toEqual(["request_user_input", "bash"]);
  });
});

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
