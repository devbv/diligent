// @summary Deterministic checks for the canonical runtime task fixtures and provider equivalence

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import { RUNTIME_CANONICAL_TASKS } from "../../../src/tasks/runtime";

describe("runtime eval tasks", () => {
  test("freezes the four-task V0 manifest and limits", () => {
    expect(RUNTIME_CANONICAL_TASKS.map((task) => task.id)).toEqual([
      "project-fix",
      "plan-readonly",
      "skill-guided-change",
      "session-resume",
    ]);
    expect(RUNTIME_CANONICAL_TASKS.every((task) => task.limits.maxOutputTokens === 8_192)).toBe(true);
  });

  test("creates equivalent independent workspaces from the same task seed", async () => {
    for (const task of RUNTIME_CANONICAL_TASKS) {
      const left = await mkdtemp(join(tmpdir(), "diligent-runtime-task-left-"));
      const right = await mkdtemp(join(tmpdir(), "diligent-runtime-task-right-"));
      try {
        await task.setup("shared-seed-123", left);
        await task.setup("shared-seed-123", right);
        expect(await captureWorkspace(left)).toEqual(await captureWorkspace(right));
      } finally {
        await removeTemporaryRoot(left);
        await removeTemporaryRoot(right);
      }
    }
  });
});
