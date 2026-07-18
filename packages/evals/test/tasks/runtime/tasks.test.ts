// @summary Deterministic checks for all runtime task fixtures and provider equivalence

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import {
  clarifyThenExecuteTask,
  collaborationDelegationTask,
  fileRoundtripTask,
  knowledgeRecallTask,
  knowledgeUpdateTask,
  manualCompactionResumeTask,
  planToExecuteTask,
  RUNTIME_EVAL_TASKS,
  readImagePairTask,
} from "../../../src/tasks/runtime";

describe("runtime eval tasks", () => {
  test("registers every runtime task in one suite", () => {
    expect(RUNTIME_EVAL_TASKS.map((task) => task.id)).toEqual([
      "project-fix",
      "plan-readonly",
      "skill-guided-change",
      "session-resume",
      "plan-to-execute",
      "knowledge-recall",
      "knowledge-update",
      "manual-compaction-resume",
      "clarify-then-execute",
      "read-image-pair",
      "collaboration-delegation",
      "file-roundtrip",
    ]);
    expect(RUNTIME_EVAL_TASKS.every((task) => task.limits.maxOutputTokens === 8_192)).toBe(true);
  });

  test("defines paired image reads with seed-controlled color assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-image-pair-"));
    try {
      const world = await readImagePairTask.setup("shared-seed-123", root);
      expect(readImagePairTask.toolPolicy.allowedTools).toEqual(["read_image"]);
      expect(JSON.stringify(readImagePairTask.createSteps(world))).toContain("A=RED; B=BLUE or A=BLUE; B=RED");
      expect(world.protectedPaths).toEqual(["a.png", "b.png"]);
      expect((await readFile(join(root, "a.png"))).subarray(1, 4).toString()).toBe("PNG");
      expect((await readFile(join(root, "b.png"))).subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("bounds collaboration to one child and one exact output mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-collaboration-"));
    try {
      const world = await collaborationDelegationTask.setup("shared-seed-123", root);
      expect(collaborationDelegationTask.limits.maxChildAgents).toBe(1);
      expect(collaborationDelegationTask.toolPolicy.allowedCapabilities).toEqual(["collab", "read", "write"]);
      expect(JSON.stringify(collaborationDelegationTask.createSteps(world))).not.toContain(world.token);
      expect(world.protectedPaths).toEqual(["src/delegated-value.txt"]);
      expect(world.allowedChanges).toEqual(["REPORT.txt"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines one ordered file overwrite with confirmation read", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-file-roundtrip-"));
    try {
      const world = await fileRoundtripTask.setup("shared-seed-123", root);
      expect(fileRoundtripTask.toolPolicy.allowedCapabilities).toEqual(["read", "write"]);
      expect(JSON.stringify(fileRoundtripTask.createSteps(world))).toContain(world.updated);
      expect(world.allowedChanges).toEqual(["document.txt"]);
      expect(await readFile(join(root, "document.txt"), "utf8")).toBe(`${world.original}\n`);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines manual compaction as turn, compact, restart, and resumed turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-manual-compaction-"));
    try {
      const world = await manualCompactionResumeTask.setup("shared-seed-123", root);
      expect(manualCompactionResumeTask.createSteps(world).map((step) => step.kind)).toEqual([
        "turn",
        "compact",
        "restart_and_resume",
        "turn",
      ]);
      expect(manualCompactionResumeTask.toolPolicy.allowedCapabilities).toEqual(["write"]);
      expect(world.allowedChanges).toEqual(["CONTEXT.json"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("scripts one user-input answer without exposing it in the task prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-clarify-execute-"));
    try {
      const world = await clarifyThenExecuteTask.setup("shared-seed-123", root);
      const steps = clarifyThenExecuteTask.createSteps(world);
      expect(steps.map((step) => (step.kind === "turn" ? step.mode : step.kind))).toEqual(["plan", "default"]);
      expect(JSON.stringify(steps)).not.toContain(world.answer);
      expect(clarifyThenExecuteTask.limits.maxUserInputRequests).toBe(1);
      const response = await clarifyThenExecuteTask.respondToServerRequest?.(world, {
        method: "userInput/request",
        params: {
          threadId: "thread-1",
          request: {
            questions: [
              {
                id: "release_target",
                header: "Target",
                question: "Which release target should be used?",
                options: [{ label: "Custom", description: "Provide the required target." }],
              },
            ],
          },
        },
      });
      expect(response).toEqual({
        method: "userInput/request",
        result: { answers: { release_target: world.answer } },
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines plan-to-execute as a plan diagnosis followed by default-mode mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-plan-execute-"));
    try {
      const world = await planToExecuteTask.setup("shared-seed-123", root);
      expect(
        planToExecuteTask.createSteps(world).map((step) => (step.kind === "turn" ? step.mode : step.kind)),
      ).toEqual(["plan", "default"]);
      const planStep = planToExecuteTask.createSteps(world)[0];
      expect(planStep.kind === "turn" ? planStep.message : "").toContain("You must call read on both src/value.ts");
      expect(planToExecuteTask.toolPolicy.allowedCapabilities).toEqual(["read", "write", "execute"]);
      expect(world.allowedChanges).toEqual(["src/value.ts"]);
      expect(world.protectedPaths).toEqual(["test/value.test.ts", "AGENTS.md", "package.json"]);
      expect(await readFile(join(root, "src/value.ts"), "utf8")).not.toBe(world.expected);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("isolates knowledge recall so the seeded value exists only in project knowledge", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-recall-"));
    try {
      const world = await knowledgeRecallTask.setup("shared-seed-123", root);
      const steps = knowledgeRecallTask.createSteps(world);
      const knowledge = await readFile(join(root, ".diligent/knowledge/knowledge.jsonl"), "utf8");
      expect(knowledge).toContain(world.token);
      expect(JSON.stringify(steps)).not.toContain(world.token);
      expect(knowledgeRecallTask.toolPolicy.allowedCapabilities).toEqual(["write"]);
      expect(world.allowedChanges).toEqual(["RELEASE.txt"]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines knowledge update as a stable-id search followed by an in-place preference update", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-update-"));
    try {
      const world = await knowledgeUpdateTask.setup("shared-seed-123", root);
      expect(knowledgeUpdateTask.toolPolicy.allowedTools).toEqual(["search_knowledge", "update_knowledge"]);
      expect(knowledgeUpdateTask.toolPolicy.allowedCapabilities).toEqual(["knowledge"]);
      expect(knowledgeUpdateTask.createSteps(world)).toHaveLength(1);
      expect(JSON.stringify(knowledgeUpdateTask.createSteps(world))).toContain(world.knowledgeId);
      expect(JSON.stringify(knowledgeUpdateTask.createSteps(world))).toContain(world.token);
      expect(world.allowedChanges).toEqual([]);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("creates equivalent independent workspaces from the same task seed", async () => {
    for (const task of RUNTIME_EVAL_TASKS) {
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
