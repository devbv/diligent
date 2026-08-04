// @summary Tests for faithful Anthropic function-tool schema forwarding
import { describe, expect, test } from "bun:test";
import { convertTools } from "../../../../src/llm/provider/anthropic";
import type { ToolDefinition } from "../../../../src/llm/types";

describe("convertTools function schemas", () => {
  function fnTool(inputSchema: Record<string, unknown>): ToolDefinition {
    return {
      kind: "function",
      name: "t",
      description: "d",
      inputSchema,
    } as ToolDefinition;
  }
  function schemaOf(inputSchema: Record<string, unknown>): Record<string, unknown> {
    const tools = convertTools([fnTool(inputSchema)]);
    return (tools?.[0] as { input_schema: Record<string, unknown> }).input_schema;
  }

  test("passes a plain object schema through unchanged", () => {
    const schema = schemaOf({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("preserves a top-level anyOf without changing its semantics", () => {
    const schema = schemaOf({
      type: "object",
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      ],
    });
    expect(schema).toEqual({
      type: "object",
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
  });
});
