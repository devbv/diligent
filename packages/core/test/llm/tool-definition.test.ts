// @summary Tests for normalized tool definition unions and provider-side function filtering
import { describe, expect, test } from "bun:test";
import { buildTools } from "../../src/llm/provider/openai/responses";
import type { ToolDefinition } from "../../src/llm/types";

describe("ToolDefinition", () => {
  test("OpenAI tool builder includes function tools and merged provider-native web tool", () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
      },
      {
        kind: "provider_builtin",
        capability: "web",
        options: {
          allowedDomains: ["example.com"],
        },
      },
    ];

    expect(buildTools(tools, true)).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
        strict: true,
      },
      {
        type: "web_search",
        filters: {
          allowed_domains: ["example.com"],
        },
      },
    ]);
  });
});
