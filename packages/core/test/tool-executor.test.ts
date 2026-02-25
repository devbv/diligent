import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { executeTool } from "../src/tool/executor";
import { ToolRegistryBuilder } from "../src/tool/registry";
import type { Tool, ToolContext } from "../src/tool/types";
import type { ToolCallBlock } from "../src/types";

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    approve: async () => "once" as const,
  };
}

const echoTool: Tool<z.ZodObject<{ message: z.ZodString }>> = {
  name: "echo",
  description: "Echo a message",
  parameters: z.object({ message: z.string() }),
  async execute(args) {
    return { output: args.message };
  },
};

describe("executeTool", () => {
  test("known tool with valid args → success", async () => {
    const registry = new ToolRegistryBuilder().register(echoTool).build();
    const toolCall: ToolCallBlock = {
      type: "tool_call",
      id: "tc_1",
      name: "echo",
      input: { message: "hello" },
    };

    const result = await executeTool(registry, toolCall, makeCtx());
    expect(result.output).toBe("hello");
  });

  test("unknown tool → error result", async () => {
    const registry = new ToolRegistryBuilder().build();
    const toolCall: ToolCallBlock = {
      type: "tool_call",
      id: "tc_1",
      name: "nonexistent",
      input: {},
    };

    const result = await executeTool(registry, toolCall, makeCtx());
    expect(result.output).toContain('Unknown tool "nonexistent"');
    expect(result.metadata?.error).toBe(true);
  });

  test("invalid args (Zod failure) → error result", async () => {
    const registry = new ToolRegistryBuilder().register(echoTool).build();
    const toolCall: ToolCallBlock = {
      type: "tool_call",
      id: "tc_1",
      name: "echo",
      input: { message: 123 }, // should be string
    };

    const result = await executeTool(registry, toolCall, makeCtx());
    expect(result.output).toContain("Invalid arguments");
    expect(result.metadata?.error).toBe(true);
  });

  test("duplicate tool name throws in builder", () => {
    expect(() => {
      new ToolRegistryBuilder().register(echoTool).register(echoTool);
    }).toThrow("Duplicate tool name: echo");
  });
});
