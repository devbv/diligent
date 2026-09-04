// @summary Tests the compact Codex-OAuth image-to-Studio asset workflow.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@diligent/core/tool-contract";
import { createStudioRpcToolProvider } from "../../src/tools/studiorpc";
import type { GenerateCodexImage } from "../../src/tools/studiorpc/tools/generate-image-asset-tool";

function project(): { cwd: string; cleanup(): void } {
  const cwd = join(tmpdir(), `image-asset-${process.pid}-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function toolFor(input: {
  cwd: string;
  generateCodexImage: GenerateCodexImage;
  approve?: "once" | "reject";
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
}): Promise<Tool | undefined> {
  const provider = createStudioRpcToolProvider({
    generateCodexImage: input.generateCodexImage,
    callRpc: async (method, params) => {
      input.calls.push({ method, params });
      if (method === "asset_manager.image.import") {
        return { asset: { assetid: "ovdrassetid://12345" } };
      }
      return {};
    },
  });
  const tools = await provider.createTools({
    cwd: input.cwd,
    host: { approve: async () => input.approve ?? "once" },
  });
  return tools.find((candidate) => candidate.name === "studiorpc_generate_image_asset");
}

describe("studiorpc_generate_image_asset", () => {
  test("generates with Codex OAuth, imports the saved image, and returns its asset ID", async () => {
    const { cwd, cleanup } = project();
    const sourcePath = join(cwd, "codex-output.png");
    writeFileSync(sourcePath, "image-data");
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const generated: string[] = [];
    const generateCodexImage: GenerateCodexImage = async ({ prompt }) => {
      generated.push(prompt);
      return { sourcePath, revisedPrompt: "refined" };
    };

    try {
      const tool = await toolFor({ cwd, generateCodexImage, calls });
      const result = await tool!.execute(
        { prompt: "A square blue coin icon with a transparent background" },
        { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
      );
      const output = JSON.parse(result.output) as { assetId: string; file: string; source: string };

      expect(generated).toEqual(["A square blue coin icon with a transparent background"]);
      expect(output).toMatchObject({ assetId: "ovdrassetid://12345", source: "codex-oauth" });
      expect(await readFile(output.file, "utf8")).toBe("image-data");
      expect(calls).toEqual([
        { method: "asset_manager.image.import", params: { file: output.file } },
        { method: "level.save.file", params: {} },
      ]);
      expect(result.outputImages?.[0]?.source.media_type).toBe("image/png");
    } finally {
      cleanup();
    }
  });

  test("does not call Codex when approval is rejected", async () => {
    const { cwd, cleanup } = project();
    let calls = 0;
    const generateCodexImage: GenerateCodexImage = async () => {
      calls += 1;
      return { sourcePath: "/private/tmp/unused.png" };
    };

    try {
      const tool = await toolFor({ cwd, generateCodexImage, approve: "reject", calls: [] });
      await expect(
        tool!.execute(
          { prompt: "A red button" },
          { toolCallId: "test", signal: new AbortController().signal, abort: () => {} },
        ),
      ).resolves.toEqual({
        output: "[Rejected by user]",
        metadata: { error: true, operation: "image_generation" },
      });
      expect(calls).toBe(0);
    } finally {
      cleanup();
    }
  });
});
