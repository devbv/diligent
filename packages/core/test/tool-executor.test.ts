import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { executeTool } from "../src/tool/executor";
import { ToolRegistryBuilder } from "../src/tool/registry";
import { TRUNCATION_WARNING } from "../src/tool/truncation";
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

  test("auto-truncates large output with WARNING marker", async () => {
    const bigTool: Tool = {
      name: "big",
      description: "Returns big output",
      parameters: z.object({}),
      async execute() {
        return { output: "x".repeat(60_000) };
      },
    };
    const registry = new ToolRegistryBuilder().register(bigTool).build();
    const toolCall: ToolCallBlock = { type: "tool_call", id: "tc_1", name: "big", input: {} };

    const result = await executeTool(registry, toolCall, makeCtx());
    expect(result.output).toContain("WARNING");
    expect(result.output).toContain("truncated");
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.fullOutputPath).toBeDefined();
  });

  test("auto-truncates with head_tail direction", async () => {
    const bigTool: Tool = {
      name: "big_ht",
      description: "Returns big output with head_tail hint",
      parameters: z.object({}),
      async execute() {
        const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
        return { output: lines, truncateDirection: "head_tail" as const };
      },
    };
    const registry = new ToolRegistryBuilder().register(bigTool).build();
    const toolCall: ToolCallBlock = { type: "tool_call", id: "tc_1", name: "big_ht", input: {} };

    const result = await executeTool(registry, toolCall, makeCtx());
    expect(result.output).toContain("line 0"); // head preserved
    expect(result.output).toContain("line 2999"); // tail preserved
    expect(result.output).toContain("omitted"); // head_tail marker
    expect(result.output).toContain("WARNING"); // warning marker
    expect(result.truncateDirection).toBe("head_tail");
  });
});
