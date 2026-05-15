// @summary Tests for protocol content block schemas
import { describe, expect, test } from "bun:test";
import {
  ProviderToolUseBlockSchema,
  ToolCallBlockSchema,
  WebFetchResultBlockSchema,
  WebSearchResultBlockSchema,
} from "../src/content-blocks";

describe("ToolCallBlockSchema", () => {
  test("preserves provider metadata for provider-specific replay fields", () => {
    const parsed = ToolCallBlockSchema.parse({
      type: "tool_call",
      id: "gemini-bash-1",
      name: "bash",
      input: { command: "pwd" },
      providerMetadata: { gemini: { thoughtSignature: "sig-123" } },
    });

    expect(parsed.providerMetadata).toEqual({ gemini: { thoughtSignature: "sig-123" } });
  });
});

describe("provider-native web block schemas", () => {
  test("accept gemini as a provider for web tool blocks", () => {
    expect(
      ProviderToolUseBlockSchema.parse({
        type: "provider_tool_use",
        id: "gemini-web-search",
        provider: "gemini",
        name: "web_search",
        input: { queries: ["diligent"] },
      }).provider,
    ).toBe("gemini");

    expect(
      WebSearchResultBlockSchema.parse({
        type: "web_search_result",
        toolUseId: "gemini-web-search",
        provider: "gemini",
        results: [{ url: "https://example.com", title: "Example" }],
      }).provider,
    ).toBe("gemini");

    expect(
      WebFetchResultBlockSchema.parse({
        type: "web_fetch_result",
        toolUseId: "gemini-web-fetch",
        provider: "gemini",
        url: "https://example.com",
      }).provider,
    ).toBe("gemini");
  });
});
