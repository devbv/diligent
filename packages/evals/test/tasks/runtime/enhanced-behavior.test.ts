// @summary Focused regressions for redesigned and newly added runtime eval behaviors

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFunction } from "@diligent/core/provider-contract";
import { runRuntimeEvalExecution } from "../../../src/runner/runtime-execution";
import { removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import {
  autonomousExploreDelegationTask,
  clarifyThenExecuteTask,
  crossFileContractFixTask,
  freshPromptAfterCompactionTask,
  inputCancelResumeTask,
  mcpNeedsAuthAbstainTask,
  planToExecuteTask,
} from "../../../src/tasks/runtime";
import { writeFixture } from "../../../src/tasks/runtime/helpers";
import { assistantMessage, sequenceStream } from "../../helpers/fake-stream";

describe("enhanced runtime eval behaviors", () => {
  test("surfaces fixture MCP needs_auth and abstains without advertising a callable tool", async () => {
    let sawAuthNote = false;
    const stream: StreamFunction = (model, context, options) => {
      sawAuthNote = context.systemPrompt.some(
        (section) => section.label === "mcp_needs_auth" && section.content.includes("/mcp login fixture-secure"),
      );
      return sequenceStream([
        assistantMessage([
          {
            type: "text",
            text: "The service requires authentication. Run `/mcp login fixture-secure` and retry.",
          },
        ]),
      ])(model, context, options);
    };

    const result = await runRuntimeEvalExecution({
      task: mcpNeedsAuthAbstainTask,
      seed: "shared-seed-123",
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: stream,
    });

    expect(result.failures).toEqual([]);
    expect(sawAuthNote).toBe(true);
    expect(result.execution.toolCalls).toEqual([]);
    expect(result.worldSnapshot).toMatchObject({ serverName: "fixture-secure", authRequests: expect.any(Number) });
  });

  test("withdraws the private plan diagnosis before the execute turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-plan-handoff-"));
    try {
      const world = await planToExecuteTask.setup("shared-seed-123", root);
      expect(await readFile(join(root, world.diagnosisPath), "utf8")).toContain(world.token);
      const step = planToExecuteTask.createSteps(world)[1]!;
      await planToExecuteTask.prepareStep?.(world, step, 1);
      await expect(readFile(join(root, world.diagnosisPath), "utf8")).rejects.toThrow();
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("keeps the fresh post-compaction requirement out of the large prior turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-fresh-compaction-"));
    try {
      const world = await freshPromptAfterCompactionTask.setup("shared-seed-123", root);
      const steps = freshPromptAfterCompactionTask.createSteps(world);
      expect(steps).toHaveLength(2);
      expect(steps[0]!.kind === "turn" ? steps[0]!.message.length : 0).toBeGreaterThan(250_000);
      expect(JSON.stringify(steps[0])).not.toContain(world.freshValue);
      expect(JSON.stringify(steps[1])).toContain(world.freshValue);
      const config = await freshPromptAfterCompactionTask.createRuntimeConfig(world, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "medium",
      });
      expect(config.compaction).toMatchObject({ enabled: true, reservePercent: 99.95 });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("uses decision modes and role-compatible prompts without scripting tool names", async () => {
    const roots = await Promise.all(
      ["clarify", "cancel", "explore"].map((name) => mkdtemp(join(tmpdir(), `diligent-${name}-`))),
    );
    try {
      const clarify = await clarifyThenExecuteTask.setup("shared-seed-123", roots[0]!);
      const cancel = await inputCancelResumeTask.setup("shared-seed-123", roots[1]!);
      const explore = await autonomousExploreDelegationTask.setup("shared-seed-123", roots[2]!);
      const clarifySteps = clarifyThenExecuteTask.createSteps(clarify);
      const cancelSteps = inputCancelResumeTask.createSteps(cancel);
      expect(clarifySteps.map((step) => (step.kind === "turn" ? step.mode : step.kind))).toEqual(["plan", "execute"]);
      expect(JSON.stringify(clarifySteps)).not.toContain("request_user_input");
      expect(JSON.stringify(clarifySteps[0])).toContain("deploy/staging.channel");
      expect(JSON.stringify(clarifySteps[0])).toContain("deploy/production.channel");
      expect(cancelSteps.map((step) => (step.kind === "turn" ? step.mode : step.kind))).toEqual(["plan", "execute"]);
      expect(JSON.stringify(cancelSteps[0])).toContain("targets/alpha.txt");
      expect(JSON.stringify(cancelSteps[0])).toContain("targets/beta.txt");
      expect(JSON.stringify(cancelSteps[0])).toContain("no selection is provided");
      expect(JSON.stringify(cancelSteps[1])).toContain(cancel.targetPath);
      expect(explore.sourcePaths).toHaveLength(6);
      expect(explore.sourcePaths.every((path) => path.startsWith("reference-map/"))).toBe(true);
      expect(explore.sourcePaths.every((path) => path.split("/").length === 3)).toBe(true);
      expect(new Set(explore.sourcePaths.map((path) => path.split(".").at(-1))).size).toBeGreaterThan(1);
      expect(explore.clientPrompt).toContain("region_marker");
      expect(explore.clientPrompt).toContain("filename variants");
      expect(explore.clientPrompt.toLowerCase()).not.toContain("review");
      expect(explore.clientPrompt.toLowerCase()).not.toContain("audit");
      expect(explore.clientPrompt.toLowerCase()).not.toContain("agent");
      expect(explore.clientPrompt.toLowerCase()).not.toContain("delegat");
    } finally {
      await Promise.all(roots.map(removeTemporaryRoot));
    }
  });

  test("verifies the replacement coding task by parser-caller behavior rather than source hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-cross-file-"));
    try {
      const world = await crossFileContractFixTask.setup("shared-seed-123", root);
      await writeFixture(root, {
        "src/parse-duration.ts": [
          `// ${world.marker}`,
          "export function parseDuration(value: string): number {",
          '  if (!/^\\d+s$/.test(value)) throw new Error("duration must use whole seconds");',
          "  return Number(value.slice(0, -1)) * 1000;",
          "}",
          "",
        ].join("\n"),
        "src/retry-config.ts": [
          'import { parseDuration } from "./parse-duration";',
          "export interface RetryConfig { delayMs: number; attempts: number }",
          "export function loadRetryConfig(raw: { retryDelay: string; attempts: number }): RetryConfig {",
          "  return { delayMs: parseDuration(raw.retryDelay), attempts: raw.attempts };",
          "}",
          "",
        ].join("\n"),
      });
      expect((await crossFileContractFixTask.verify?.(world, new AbortController().signal))?.exitCode).toBe(0);
      expect("expectedHash" in world).toBe(false);
    } finally {
      await removeTemporaryRoot(root);
    }
  });
});
