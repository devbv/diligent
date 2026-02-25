import { describe, expect, test } from "bun:test";
import { join } from "path";
import { pairToolCalls } from "../src/client/lib/toolPairing.js";
import { parseSessionFile } from "../src/server/parser.js";

const SAMPLE_DIR = join(import.meta.dir, "../src/server/sample-data/sessions");

describe("pairToolCalls (client-side)", () => {
  test("pairs tool calls in sample-001", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const pairs = pairToolCalls(entries);

    expect(pairs.size).toBe(2);

    // tc-001-01: read
    const readPair = pairs.get("tc-001-01");
    expect(readPair).toBeDefined();
    expect(readPair!.call.name).toBe("read");
    expect(readPair!.result).toBeDefined();
    expect(readPair!.result!.toolName).toBe("read");
    expect(readPair!.result!.isError).toBe(false);

    // tc-001-02: bash
    const bashPair = pairs.get("tc-001-02");
    expect(bashPair).toBeDefined();
    expect(bashPair!.call.name).toBe("bash");
  });

  test("detects errors in sample-002", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-002.jsonl"));
    const pairs = pairToolCalls(entries);

    expect(pairs.size).toBe(5);

    // tc-002-03 should be an error
    const errorPair = pairs.get("tc-002-03");
    expect(errorPair).toBeDefined();
    expect(errorPair!.result?.isError).toBe(true);
  });

  test("has timing info", async () => {
    const entries = await parseSessionFile(join(SAMPLE_DIR, "sample-001.jsonl"));
    const pairs = pairToolCalls(entries);

    const readPair = pairs.get("tc-001-01");
    expect(readPair!.startTime).toBeNumber();
    expect(readPair!.endTime).toBeNumber();
    expect(readPair!.endTime!).toBeGreaterThan(readPair!.startTime);
  });
});
