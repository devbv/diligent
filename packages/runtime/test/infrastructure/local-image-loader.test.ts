// @summary Tests runtime-owned persisted local-image paths and filesystem loading

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localImageLoader,
  resolvePersistedLocalImagePath,
  toPersistedLocalImagePath,
} from "../../src/infrastructure/local-image-loader";

describe("local image loader", () => {
  it("stores project-local image paths relative to cwd", () => {
    expect(toPersistedLocalImagePath("/workspace/project/.diligent/images/example.png", "/workspace/project")).toBe(
      ".diligent/images/example.png",
    );
  });

  it("resolves relative persisted paths and keeps legacy absolute paths", () => {
    expect(resolvePersistedLocalImagePath(".diligent/images/example.png", "/workspace/project")).toBe(
      "/workspace/project/.diligent/images/example.png",
    );
    expect(resolvePersistedLocalImagePath("/tmp/example.png", "/workspace/project")).toBe("/tmp/example.png");
  });

  it("returns null for missing files and bytes for existing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "diligent-local-image-"));
    try {
      expect(
        await localImageLoader.load({ type: "local_image", path: "missing.png", mediaType: "image/png" }, cwd),
      ).toBeNull();
      const dir = join(cwd, ".diligent", "images");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "example.png"), "image-bytes");
      const bytes = await localImageLoader.load(
        { type: "local_image", path: ".diligent/images/example.png", mediaType: "image/png" },
        cwd,
      );
      expect(Buffer.from(bytes!).toString("utf8")).toBe("image-bytes");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
