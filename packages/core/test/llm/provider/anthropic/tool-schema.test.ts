// @summary Tests for Anthropic tool schema normalization
import { describe, expect, test } from "bun:test";
import { convertTools } from "../../../../src/llm/provider/anthropic";
import type { ToolDefinition } from "../../../../src/llm/types";

describe("convertTools top-level schema flattening", () => {
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

  test("flattens a top-level anyOf, dropping the forbidden keyword", () => {
    const schema = schemaOf({
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
    expect(schema.anyOf).toBeUndefined();
    expect(schema.type).toBe("object");
    // Union of properties, and no key required by *every* branch.
    expect(schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    });
    expect(schema.required).toBeUndefined();
  });

  test("anyOf keeps keys required by all branches", () => {
    const schema = schemaOf({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { a: { type: "string" }, c: { type: "boolean" } },
          required: ["a"],
        },
      ],
    });
    expect(schema.required).toEqual(["a"]);
  });

  test("allOf merges branches and unions required keys", () => {
    const schema = schemaOf({
      allOf: [
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
    expect(schema.allOf).toBeUndefined();
    expect(schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    });
    expect(schema.required).toEqual(["a", "b"]);
  });

  test("flattens a nested union inside a branch", () => {
    const schema = schemaOf({
      anyOf: [
        { oneOf: [{ type: "object", properties: { a: { type: "string" } } }] },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    });
  });
});
