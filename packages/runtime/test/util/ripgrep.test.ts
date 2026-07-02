import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRgBinary } from "../../src/util/ripgrep";

describe("resolveRgBinary", () => {
  const originalEnv = process.env.DILIGENT_RG_PATH;

  beforeEach(() => {
    delete process.env.DILIGENT_RG_PATH;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DILIGENT_RG_PATH;
    else process.env.DILIGENT_RG_PATH = originalEnv;
  });

  test("prefers DILIGENT_RG_PATH when set", () => {
    process.env.DILIGENT_RG_PATH = "/custom/rg";
    expect(resolveRgBinary()).toBe("/custom/rg");
  });

  test("falls back to a bundled assets/bin binary next to execPath", () => {
    const binName = process.platform === "win32" ? "rg.exe" : "rg";
    const bundled = join(dirname(process.execPath), "assets", "bin", binName);
    const created = !existsSync(bundled);
    if (created) {
      mkdirSync(dirname(bundled), { recursive: true });
      writeFileSync(bundled, "");
    }
    try {
      expect(resolveRgBinary()).toBe(bundled);
    } finally {
      if (created) rmSync(bundled);
    }
  });

  test("falls back to PATH rg when no override or bundle exists", () => {
    const binName = process.platform === "win32" ? "rg.exe" : "rg";
    const bundled = join(dirname(process.execPath), "assets", "bin", binName);
    if (existsSync(bundled)) {
      expect(resolveRgBinary()).toBe(bundled);
      return;
    }
    expect(resolveRgBinary()).toBe("rg");
  });
});
