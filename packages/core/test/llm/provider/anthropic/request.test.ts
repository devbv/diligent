// @summary Anthropic system blocks preserve semantic boundaries between prompt sections

import { describe, expect, test } from "bun:test";
import { toAnthropicBlocks } from "../../../../src/llm/provider/anthropic/request";
import { flattenSections } from "../../../../src/llm/system-sections";

describe("toAnthropicBlocks", () => {
  test("renders the same separated prompt text as flat-string providers", () => {
    const sections = [
      { label: "runtime_context", content: "Current working directory: /workspace" },
      {
        label: "nested_subagent_policy",
        content: "Nested sub-agent delegation is disabled for this run.",
        cacheControl: "ephemeral" as const,
      },
      {
        label: "tagged",
        content: "Remember this boundary.",
        tag: "policy",
        tagAttributes: { scope: "child" },
      },
    ];

    const blocks = toAnthropicBlocks(sections);

    expect(blocks.map((block) => block.text).join("")).toBe(flattenSections(sections));
    expect(blocks).toEqual([
      { type: "text", text: "Current working directory: /workspace\n\n" },
      {
        type: "text",
        text: "Nested sub-agent delegation is disabled for this run.\n\n",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: '<policy scope="child">\nRemember this boundary.\n</policy>' },
    ]);
  });
});
