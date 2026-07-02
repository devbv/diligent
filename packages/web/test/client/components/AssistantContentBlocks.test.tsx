// @summary Tests merged rendering of fragmented cited text blocks in AssistantContentBlocks
import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@diligent/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantContentBlocks, mergeTextRun } from "../../../src/client/components/AssistantContentBlocks";

type TextBlock = Extract<ContentBlock, { type: "text" }>;

const citation = (url: string, citedText?: string) =>
  ({ type: "web_search_result_location", url, title: url, citedText }) as const;

describe("mergeTextRun", () => {
  test("joins fragmented text blocks without separators and dedupes citations by url", () => {
    const blocks: TextBlock[] = [
      { type: "text", text: "Competing with Roblox" },
      { type: "text", text: ", ", citations: undefined },
      { type: "text", text: "the creator flywheel is key", citations: [citation("https://a.example")] },
      { type: "text", text: ".", citations: [citation("https://a.example"), citation("https://b.example")] },
    ];

    const merged = mergeTextRun(blocks);
    expect(merged.text).toBe("Competing with Roblox, the creator flywheel is key.");
    expect(merged.citations.map((entry) => (entry.type === "web_search_result_location" ? entry.url : ""))).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("AssistantContentBlocks", () => {
  test("renders consecutive text blocks as one markdown flow with a single citation list", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Sentence start " },
      { type: "text", text: "cited middle", citations: [citation("https://a.example", "snippet")] },
      { type: "text", text: " sentence end." },
    ];

    const html = renderToStaticMarkup(<AssistantContentBlocks blocks={blocks} />);
    expect(html).toContain("Sentence start cited middle sentence end.");
    expect(html.match(/Source 1:/g)?.length ?? 0).toBe(1);
    expect(html).toContain("https://a.example");
  });

  test("keeps tool-like blocks as separate groups between text runs", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Before." },
      {
        type: "provider_tool_use",
        id: "ws_1",
        provider: "anthropic",
        name: "web_search",
        input: { type: "search", query: "diligent" },
      },
      { type: "text", text: "After part one" },
      { type: "text", text: " and part two." },
    ];

    const html = renderToStaticMarkup(<AssistantContentBlocks blocks={blocks} />);
    expect(html).toContain("Before.");
    expect(html).toContain("After part one and part two.");
  });
});
