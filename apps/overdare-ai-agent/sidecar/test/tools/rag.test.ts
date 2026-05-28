// @summary Tests OVERDARE Studio bundled RAG tool provider assembly.

import { describe, expect, mock, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";

describe("createRagToolProvider", () => {
  test("creates bundled RAG tools with Zod schemas and plugin supersession", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/rag-tools");

    expect(provider).toBeDefined();
    expect(provider!.supersedesPluginPackages).toContain("@overdare/plugin-rag");

    const tools = await provider!.createTools({ cwd: "/tmp/project" });
    const searchTool = tools.find((candidate) => candidate.name === "overdaresearch");
    const deepTool = tools.find((candidate) => candidate.name === "overdaresearch_deep");

    expect(searchTool).toBeDefined();
    expect(deepTool).toBeDefined();
    expect(searchTool!.supportParallel).toBe(true);
    expect(deepTool!.supportParallel).toBe(true);
    expect(() => searchTool!.parameters.parse({ query: "spawn location", source: "docs", topK: 3 })).not.toThrow();
    expect(() =>
      deepTool!.parameters.parse({
        action: "origin-file",
        urls: ["https://storage.googleapis.com/ovdr-docs-bucket/example.md"],
      }),
    ).not.toThrow();
  });

  test("preserves approval rejection behavior without calling RAG service", async () => {
    const fetchMock = mock(globalThis.fetch);
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const provider = providers.find((candidate) => candidate.id === "@overdare/rag-tools")!;
    const tools = await provider.createTools({
      cwd: "/tmp/project",
      host: {
        approve: async () => "reject",
      },
    });
    const searchTool = tools.find((candidate) => candidate.name === "overdaresearch")!;

    const result = await searchTool.execute(
      { query: "spawn location", source: "docs", topK: 3 },
      { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
    );

    expect(result).toEqual({ output: "[Rejected by user]", metadata: { error: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
