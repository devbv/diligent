// @summary Tests for NicknamePool: uniqueness within a pass, exhaustion reset
import { describe, expect, it } from "bun:test";
import { NicknamePool } from "@diligent/runtime/collab";

describe("NicknamePool", () => {
  it("returns strings", () => {
    const pool = new NicknamePool();
    const name = pool.reserve();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  it("returns each configured name once before reuse", () => {
    const names = ["Acacia", "Birch", "Cedar"];
    const pool = new NicknamePool({ names });
    const seen = new Set<string>();
    for (const _ of names) {
      const name = pool.reserve();
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
    expect(seen).toEqual(new Set(names));
  });

  it("resets and continues after exhaustion", () => {
    const names = ["Acacia", "Birch"];
    const pool = new NicknamePool({ names });
    for (const _ of names) {
      pool.reserve();
    }
    expect(names).toContain(pool.reserve());
  });
});
