// @summary Tests allowlisted JSON report serialization and credential redaction

import { describe, expect, test } from "bun:test";
import { serializeEvalReport } from "../../src/reporters/json";
import type { EvalSuiteReport } from "../../src/task";

describe("serializeEvalReport", () => {
  test("redacts credentials from failures, logs, and events", () => {
    const secret = "sk-ant-sentinel-secret-value";
    const report: EvalSuiteReport = {
      schemaVersion: 1,
      suiteVersion: "core-v0",
      repository: "example/repo",
      commitSha: "abc123",
      ref: "refs/heads/main",
      runId: "1",
      runAttempt: "1",
      bunVersion: "1.3.9",
      startedAt: "2026-07-17T00:00:00.000Z",
      endedAt: "2026-07-17T00:00:01.000Z",
      rootSeed: "seed",
      profiles: [{ provider: "anthropic", model: "test-model", effort: "medium" }],
      taskIds: ["task"],
      passed: false,
      executions: [
        {
          taskId: "task",
          taskSeed: "task-seed",
          profile: { provider: "anthropic", model: "test-model", effort: "medium" },
          maxOutputTokens: 512,
          passed: false,
          termination: "provider_error",
          failure: { category: "provider_auth", code: "provider_auth.rejected", message: `Bearer ${secret}` },
          failures: [{ category: "provider_auth", code: "provider_auth.rejected", message: `Bearer ${secret}` }],
          elapsedMs: 1,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          turnCount: 1,
          toolCallCount: 0,
          events: [
            {
              sequence: 1,
              relativeMs: 0,
              event: { type: "error", fatal: true, error: { name: "Error", message: secret } },
            },
          ],
          logs: [
            {
              timestamp: "2026-07-17T00:00:00.000Z",
              level: "error",
              scope: "eval",
              event: "failed",
              message: secret,
              fields: { authorization: `Bearer ${secret}` },
            },
          ],
          messages: [],
          world: {
            image: {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg" },
            },
          },
        },
      ],
    };

    const json = serializeEvalReport(report, { secrets: [secret] });
    expect(json).not.toContain(secret);
    expect(json).not.toContain("Bearer ");
    expect(json).not.toContain("iVBORw0KGgoAAAANSUhEUg");
    expect(json).toContain("[REDACTED]");
    expect(json).toContain("[base64 omitted]");
  });
});
