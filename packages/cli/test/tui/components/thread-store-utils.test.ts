// @summary Tests rendering helpers for provider-native assistant web blocks in TUI
import { describe, expect, test } from "bun:test";
import {
  renderAssistantMessageBlocks,
  renderAssistantStructuredItems,
} from "../../../src/tui/components/thread-store-utils";

describe("renderAssistantMessageBlocks", () => {
  test("renders provider-native web blocks and citations into plain transcript lines", () => {
    const rendered = renderAssistantMessageBlocks({
      content: [
        {
          type: "provider_tool_use",
          id: "ws_1",
          provider: "openai",
          name: "web_search",
          input: { type: "search", query: "diligent" },
        },
        {
          type: "web_search_result",
          toolUseId: "ws_1",
          provider: "openai",
          results: [{ url: "https://example.com", title: "Example" }],
        },
        {
          type: "text",
          text: "Found it.",
          citations: [
            { type: "web_search_result_location", url: "https://example.com", title: "Example", citedText: "Found" },
          ],
        },
      ],
    } as never);

    expect(rendered.text).toBe("Found it.");
    expect(rendered.extras).toEqual(expect.arrayContaining([expect.stringContaining("[source] Example")]));
  });

  test("renders provider-native web blocks into tool_result items", () => {
    const items = renderAssistantStructuredItems({
      content: [
        {
          type: "provider_tool_use",
          id: "ws_1",
          provider: "openai",
          name: "web_search",
          input: { type: "search", query: "diligent" },
        },
        {
          type: "web_search_result",
          toolUseId: "ws_1",
          provider: "openai",
          results: [{ url: "https://example.com", title: "Example" }],
        },
      ],
    } as never);

    const toolItems = items.filter((item) => item.kind === "tool_result");
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0] && toolItems[0].kind === "tool_result" ? toolItems[0].summaryLine : "").toContain(
      "Searched diligent",
    );
    expect(toolItems[1] && toolItems[1].kind === "tool_result" ? toolItems[1].details.join("\n") : "").toContain(
      "Found 1 result",
    );
  });
});

describe("citation dedupe across fragmented text blocks", () => {
  test("joins fragmented cited text and dedupes repeated sources", () => {
    const rendered = renderAssistantMessageBlocks({
      content: [
        { type: "text", text: "Competing with Roblox" },
        {
          type: "text",
          text: ", the flywheel is key",
          citations: [{ type: "web_search_result_location", url: "https://a.example", title: "A", citedText: "x" }],
        },
        {
          type: "text",
          text: ".",
          citations: [
            { type: "web_search_result_location", url: "https://a.example", title: "A", citedText: "y" },
            { type: "web_search_result_location", url: "https://b.example", title: "B" },
          ],
        },
      ],
    } as never);

    expect(rendered.text).toBe("Competing with Roblox, the flywheel is key.");
    const sourceLines = rendered.extras.filter((line) => line.includes("[source]"));
    expect(sourceLines).toHaveLength(2);
    expect(sourceLines[0]).toContain("A");
    expect(sourceLines[1]).toContain("B");
  });

  test("renderAssistantStructuredItems emits one deduped citation item per message", () => {
    const items = renderAssistantStructuredItems({
      content: [
        {
          type: "text",
          text: "claim one",
          citations: [{ type: "web_search_result_location", url: "https://a.example", title: "A" }],
        },
        {
          type: "text",
          text: "claim two",
          citations: [{ type: "web_search_result_location", url: "https://a.example", title: "A" }],
        },
      ],
    } as never);

    const plainItems = items.filter((item) => item.kind === "plain");
    expect(plainItems).toHaveLength(1);
    const lines = plainItems[0]?.kind === "plain" ? plainItems[0].lines : [];
    expect(lines.filter((line) => line.includes("[source]"))).toHaveLength(1);
  });
});
