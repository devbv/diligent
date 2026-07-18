// @summary Tests runtime report discrimination, recursive redaction, and bounded evidence strings

import { describe, expect, test } from "bun:test";
import { serializeEvalReport } from "../../src/reporters/json";

describe("runtime eval report", () => {
  test("keeps the runtime discriminator while redacting and truncating nested evidence", () => {
    const report = {
      schemaVersion: 1,
      suite: "runtime",
      suiteVersion: "runtime-v0",
      repository: "local/test",
      commitSha: "abc",
      ref: "local",
      runId: "local",
      runAttempt: "1",
      bunVersion: Bun.version,
      os: "test",
      architecture: "test",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(0).toISOString(),
      rootSeed: "seed",
      profiles: [],
      taskIds: [],
      passed: false,
      executions: [{ evidence: `Bearer secret-token ${"x".repeat(40_000)}`, apiKey: "sentinel" }],
    } as never;
    const serialized = serializeEvalReport(report);
    expect(serialized).toContain('"suite": "runtime"');
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("sentinel");
    expect(serialized).toContain("...[truncated");
  });
});
