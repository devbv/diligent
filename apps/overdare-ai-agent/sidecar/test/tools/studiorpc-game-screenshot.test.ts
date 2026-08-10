// @summary Tests the game.screenshot bespoke tool — outputImages attachment, includeGui forwarding, degradation.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGameScreenshotTool } from "../../src/tools/studiorpc/tools/game-screenshot-tool";
import type { ToolContext } from "../../src/tools/studiorpc/types";

// Minimal 1x1 PNG (red pixel), borrowed from common test fixtures. Small enough that
// downscaleImageIfNeeded's header fast-path returns it unchanged, so the base64 the tool
// produces should exactly match this constant.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

function makeCtx(): ToolContext {
  return {
    toolCallId: "tc_test",
    signal: new AbortController().signal,
    abort: () => {},
    approve: async () => {
      throw new Error("game.screenshot is read-only and must not request approval");
    },
  };
}

describe("createGameScreenshotTool", () => {
  let tmpDir: string;

  test("attaches the captured screenshot as outputImages", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "game-screenshot-test-"));
    const filePath = join(tmpDir, "capture.png");
    await writeFile(filePath, TINY_PNG_BYTES);

    const tool = createGameScreenshotTool(async () => ({ path: filePath }));
    const result = await tool.execute({} as never, makeCtx());

    expect(result.outputImages).toHaveLength(1);
    expect(result.outputImages?.[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 },
    });
    expect(result.render).toBeDefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("defaults includeGui to true and forwards it to Studio", async () => {
    let sentParams: Record<string, unknown> | undefined;
    const tool = createGameScreenshotTool(async (_method, params) => {
      sentParams = params;
      return {};
    });

    await tool.execute({} as never, makeCtx());

    expect(sentParams).toEqual({ includeGui: true });
  });

  test("preserves an explicit includeGui: false", async () => {
    let sentParams: Record<string, unknown> | undefined;
    const tool = createGameScreenshotTool(async (_method, params) => {
      sentParams = params;
      return {};
    });

    await tool.execute({ includeGui: false } as never, makeCtx());

    expect(sentParams).toEqual({ includeGui: false });
  });

  test("returns text-only output without outputImages when Studio returns no path", async () => {
    const tool = createGameScreenshotTool(async () => ({}));
    const result = await tool.execute({} as never, makeCtx());

    expect(result.outputImages).toBeUndefined();
    expect(result.output).toBeDefined();
  });

  test("degrades gracefully when the captured file can't be read", async () => {
    const tool = createGameScreenshotTool(async () => ({ path: "/nonexistent/does-not-exist.png" }));
    const result = await tool.execute({} as never, makeCtx());

    expect(result.outputImages).toBeUndefined();
    expect(result.output).toContain("could not be loaded for viewing");
  });
});
