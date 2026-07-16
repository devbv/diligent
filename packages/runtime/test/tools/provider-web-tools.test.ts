// @summary Tests for provider-native web built-in tools and metadata exposure
import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@diligent/core/tool/types";
import { createWebTool } from "@diligent/runtime/tools";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_1",
    signal: new AbortController().signal,
    abort: () => {},
  };
}

describe("provider-native web built-ins", () => {
  test("web placeholder tool is exposed for catalog/config flows", async () => {
    const tool = createWebTool();
    expect(tool.name).toBe("web_action");
    expect(tool.description).toContain("native web capability");
    expect(tool.modelExposure).toEqual({
      kind: "provider_builtin",
      capability: "web",
      options: { citationsEnabled: true },
    });

    const result = await tool.execute({ query: "diligent" }, makeCtx());
    expect(result.output).toContain("should not execute locally");
  });
});
