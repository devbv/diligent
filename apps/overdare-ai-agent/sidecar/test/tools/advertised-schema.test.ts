// @summary Guards that every bundled tool advertises a provider-safe object input schema.

import { describe, expect, test } from "bun:test";
import { toToolInputSchema } from "@diligent/core/tool-contract";
import { createStudioBundledToolProviders } from "../../src/tools";

describe("bundled tool input schemas", () => {
  test("every tool advertises an object schema with no top-level union", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
    const tools = (
      await Promise.all(providers.map((provider) => provider.createTools({ cwd: "/tmp/project" })))
    ).flat();

    expect(tools.length).toBeGreaterThan(0);

    // Anthropic rejects the entire request with `input_schema.type: Field required` when a tool
    // schema has no `type`, and a top-level `anyOf` (what a Zod union converts to) is the way that
    // happens. Providers forward the schema as-is, so the invariant has to hold at the source.
    const offenders = tools
      .map((tool) => ({ name: tool.name, schema: toToolInputSchema(tool) }))
      .filter(({ schema }) => schema.type !== "object" || schema.anyOf !== undefined || schema.oneOf !== undefined)
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
