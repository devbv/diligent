// @summary Tests OVERDARE Studio bundled hello-world tool provider assembly.

import { describe, expect, test } from "bun:test";
import { createStudioBundledToolProviders } from "../../src/tools";

describe("createStudioBundledToolProviders", () => {
  test("creates an executable hello_world bundled tool with a Zod schema", async () => {
    const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });

    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers[0].id).toBe("@overdare/hello-world-tools");

    const tools = await providers[0].createTools({ cwd: "/tmp/project" });
    const tool = tools.find((candidate) => candidate.name === "hello_world");

    expect(tool).toBeDefined();
    expect(() => tool!.parameters.parse({ name: "OVERDARE" })).not.toThrow();
    await expect(
      tool!.execute(
        { name: "OVERDARE" },
        { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
      ),
    ).resolves.toEqual({ output: "Hello, OVERDARE! cwd=/tmp/project" });
  });
});
