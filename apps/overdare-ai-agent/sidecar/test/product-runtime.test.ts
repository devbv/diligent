// @summary Tests OVERDARE sidecar runtime options for bundled product agents.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOverdareRuntimeConfigOptions,
  OVERDARE_BUNDLED_TOOL_NAMES,
  resolveOverdareBootstrapAgentsPath,
} from "../src/product-runtime";

let tmpRoot = "";

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("OVERDARE runtime config options", () => {
  test("uses bundled tool names that match the sidecar registry", () => {
    expect(OVERDARE_BUNDLED_TOOL_NAMES).toContain("overdaresearch");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).toContain("overdaresearch_deep");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).toContain("hub_world_lookup");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).toContain("hub_world_categories_list");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).not.toContain("overdare_research");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).not.toContain("overdare_research_deep");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).not.toContain("studiorpc_hub_world_lookup");
    expect(OVERDARE_BUNDLED_TOOL_NAMES).not.toContain("studiorpc_hub_world_categories_list");
  });

  test("resolves the source-tree bootstrap agents directory", () => {
    const path = resolveOverdareBootstrapAgentsPath();
    expect(path).toBeDefined();
    expect(path).toContain("apps/overdare-ai-agent/bootstrap/agents");
  });

  test("adds product agent path and routing prompt section", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "overdare-runtime-agents-"));
    const configOptions = createOverdareRuntimeConfigOptions(undefined, {
      OVERDARE_BOOTSTRAP_AGENTS_PATH: tmpRoot,
    });

    expect(configOptions.agentPaths).toEqual([tmpRoot]);
    expect(
      configOptions.systemPromptSections?.some((section) => section.label === "overdare_autoplay_qa_routing"),
    ).toBe(true);
  });
});
