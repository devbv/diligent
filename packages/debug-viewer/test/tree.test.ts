import { describe, expect, test } from "bun:test";
import { join } from "path";
import { buildSessionTree, getLinearPath, hasForking } from "../src/client/lib/tree.js";
import { parseSessionFile } from "../src/server/parser.js";

const SAMPLE_DIR = join(import.meta.dir, "../src/server/sample-data/sessions");

describe("buildSessionTree", () => {
  test("builds tree from simple session", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const tree = buildSessionTree(entries);

    expect(tree.roots.length).toBe(2); // session_header + first user msg
    expect(tree.entries.size).toBe(9);
  });

  test("builds tree with forking", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    const tree = buildSessionTree(entries);

    // msg-003-06 should have 2 children (fork)
    const children = tree.children.get("msg-003-06");
    expect(children?.length).toBe(2);
  });
});

describe("getLinearPath", () => {
  test("returns linear path for simple session", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const tree = buildSessionTree(entries);
    const path = getLinearPath(tree);

    // Should follow main branch (first child at each step)
    expect(path.length).toBeGreaterThan(0);

    // IDs should be in order
    const ids = path.map((e) => e.id);
    expect(ids[0]).toBe("sample-001"); // session header
    expect(ids[1]).toBe("msg-001-01"); // first user msg
  });

  test("follows main branch at forks", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    const tree = buildSessionTree(entries);
    const path = getLinearPath(tree);

    const ids = path.map((e) => e.id);

    // Should include msg-003-07 (first child) not msg-003-10 (fork)
    expect(ids).toContain("msg-003-07");
    expect(ids).not.toContain("msg-003-10");
  });
});

describe("hasForking", () => {
  test("no forking in sample-001", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const tree = buildSessionTree(entries);
    expect(hasForking(tree)).toBe(false);
  });

  test("detects forking in sample-003", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-003.jsonl"));
    const tree = buildSessionTree(entries);
    expect(hasForking(tree)).toBe(true);
  });
});
