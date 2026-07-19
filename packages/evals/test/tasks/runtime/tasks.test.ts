// @summary Deterministic checks for all runtime task fixtures and provider equivalence

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, removeTemporaryRoot } from "../../../src/runner/runtime-workspace";
import type {
  AnyRuntimeEvalTask,
  RuntimeEvalExecution,
  RuntimeEvalTask,
  RuntimeToolTrace,
} from "../../../src/runtime-task";
import {
  bundledToolRoutingTask,
  clarifyThenExecuteTask,
  collaborationParallelSynthesisTask,
  collaborationResumeReferenceTask,
  customAgentRoutingTask,
  executeAutonomousTask,
  fileRoundtripTask,
  hookContextFollowTask,
  imageResumeRecallTask,
  instructionHierarchyTask,
  knowledgeForgetTask,
  knowledgeIntentSplitTask,
  knowledgeRecallTask,
  loopContextAdaptationTask,
  manualCompactionResumeTask,
  mcpLazyToolTask,
  mcpPromptGroundingTask,
  mcpResourceGroundingTask,
  planConvergeTask,
  planProgressTask,
  planToExecuteTask,
  RUNTIME_EVAL_TASKS,
  readImagePairTask,
  skillAbstainTask,
  skillAutoSelectTask,
} from "../../../src/tasks/runtime";
import { type RuntimeFixtureWorld, writeFixture } from "../../../src/tasks/runtime/helpers";

describe("runtime eval tasks", () => {
  test("registers every runtime task in one suite", () => {
    expect(RUNTIME_EVAL_TASKS.map((task) => task.id)).toEqual([
      "project-fix",
      "plan-readonly",
      "session-resume",
      "plan-to-execute",
      "knowledge-recall",
      "manual-compaction-resume",
      "clarify-then-execute",
      "read-image-pair",
      "file-roundtrip",
      "instruction-hierarchy",
      "plan-converge",
      "execute-autonomous",
      "plan-progress",
      "hook-context-follow",
      "skill-auto-select",
      "skill-abstain",
      "knowledge-intent-split",
      "knowledge-forget",
      "steer-during-fix",
      "auto-compaction-resume",
      "image-resume-recall",
      "loop-context-adaptation",
      "large-output-recovery",
      "bundled-tool-routing",
      "mcp-lazy-tool",
      "mcp-resource-grounding",
      "mcp-prompt-grounding",
      "custom-agent-routing",
      "collaboration-parallel-synthesis",
      "collaboration-resume-reference",
    ]);
    expect(RUNTIME_EVAL_TASKS.every((task) => task.limits.maxOutputTokens === 8_192)).toBe(true);
    expect(RUNTIME_EVAL_TASKS.every((task) => task.statePolicy !== undefined)).toBe(true);
    expect(knowledgeIntentSplitTask.statePolicy).toEqual({
      allowedMutations: ["infrastructure", "sessions", "knowledge"],
      requiredMutations: ["knowledge"],
    });
    expect(knowledgeForgetTask.statePolicy).toEqual({
      allowedMutations: ["infrastructure", "sessions", "knowledge"],
      requiredMutations: ["knowledge"],
    });
    expect(readImagePairTask.statePolicy).toEqual({
      allowedMutations: ["infrastructure", "sessions", "image_sidecars"],
      requiredMutations: ["image_sidecars"],
    });
    expect(imageResumeRecallTask.statePolicy).toEqual({
      allowedMutations: ["infrastructure", "sessions", "image_sidecars"],
      requiredMutations: ["image_sidecars"],
    });
    expect(loopContextAdaptationTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    expect(knowledgeRecallTask.statePolicy?.allowedMutations).not.toContain("knowledge");
    expect(RUNTIME_EVAL_TASKS).toHaveLength(30);
    expect(RUNTIME_EVAL_TASKS.length * 2).toBe(60);
  });

  test("defines custom agent routing as a fixture-local collaboration task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-custom-agent-routing-"));
    try {
      const world = await customAgentRoutingTask.setup("shared-seed-123", root);
      expect(customAgentRoutingTask.id).toBe("custom-agent-routing");
      expect(customAgentRoutingTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.allowedChanges).toEqual(["release-authorization.txt"]);
      expect(customAgentRoutingTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines parallel synthesis as a two-region fixture-local collaboration task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-collaboration-parallel-"));
    try {
      const world = await collaborationParallelSynthesisTask.setup("shared-seed-123", root);
      expect(collaborationParallelSynthesisTask.id).toBe("collaboration-parallel-synthesis");
      expect(collaborationParallelSynthesisTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.sourcePaths).toHaveLength(2);
      expect(new Set(world.sourcePaths).size).toBe(2);
      expect(world.allowedChanges).toEqual(["parallel-synthesis.txt"]);
      expect(world.clientPrompt).toContain("Do not spawn any additional specialist");
      expect(world.clientPrompt).toContain("create the artifact yourself as the parent");
      expect(collaborationParallelSynthesisTask.limits.maxChildAgents).toBe(2);
      expect(collaborationParallelSynthesisTask.limits.maxToolCalls).toBe(8);
      expect(collaborationParallelSynthesisTask.statePolicy).toEqual({
        allowedMutations: ["infrastructure", "sessions"],
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines resume reference as a restart-bound fixture-local collaboration task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-collaboration-resume-"));
    try {
      const world = await collaborationResumeReferenceTask.setup("shared-seed-123", root);
      expect(collaborationResumeReferenceTask.id).toBe("collaboration-resume-reference");
      expect(collaborationResumeReferenceTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.prompts[0] },
        { kind: "restart_and_resume" },
        { kind: "turn", mode: "default", message: world.prompts[1] },
      ]);
      expect(world.sourcePaths).toHaveLength(2);
      expect(world.allowedChanges).toEqual(["collaboration-resume-reference.txt"]);
      expect(collaborationResumeReferenceTask.limits.maxChildAgents).toBe(2);
      expect(collaborationResumeReferenceTask.limits.maxToolCalls).toBe(8);
      expect(collaborationResumeReferenceTask.statePolicy).toEqual({
        allowedMutations: ["infrastructure", "sessions"],
      });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines MCP resource grounding as a fixture-local artifact task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-resource-"));
    try {
      const world = await mcpResourceGroundingTask.setup("shared-seed-123", root);
      expect(mcpResourceGroundingTask.id).toBe("mcp-resource-grounding");
      expect(mcpResourceGroundingTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.allowedChanges).toEqual(["grounded-answer.txt"]);
      expect(mcpResourceGroundingTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines MCP prompt grounding as a fixture-local artifact task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-prompt-"));
    try {
      const world = await mcpPromptGroundingTask.setup("shared-seed-123", root);
      expect(mcpPromptGroundingTask.id).toBe("mcp-prompt-grounding");
      expect(mcpPromptGroundingTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.allowedChanges).toEqual(["orbital-workflow.txt"]);
      expect(mcpPromptGroundingTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines MCP lazy routing as a fixture-local auto-threshold task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-mcp-lazy-"));
    try {
      const world = await mcpLazyToolTask.setup("shared-seed-123", root);
      expect(mcpLazyToolTask.id).toBe("mcp-lazy-tool");
      expect(mcpLazyToolTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.allowedChanges).toEqual([]);
      expect(mcpLazyToolTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines bundled tool routing as an isolated natural-intent task", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-bundled-routing-"));
    try {
      const world = await bundledToolRoutingTask.setup("shared-seed-123", root);
      expect(bundledToolRoutingTask.id).toBe("bundled-tool-routing");
      expect(bundledToolRoutingTask.createBundledToolProviders?.(world)).toHaveLength(2);
      expect(bundledToolRoutingTask.createSteps(world)).toEqual([
        { kind: "turn", mode: "default", message: world.clientPrompt },
      ]);
      expect(world.clientPrompt).not.toContain(world.receipt);
      expect(world.protectedPaths).toEqual(["manifest.json", ".git/.keep"]);
      expect(world.allowedChanges).toEqual([]);
      expect(bundledToolRoutingTask.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("defines opaque intent-based skill selection and advertised abstention fixtures", async () => {
    expect(skillAutoSelectTask.limits).toMatchObject({ maxTurns: 5, maxToolCalls: 4 });
    expect(skillAutoSelectTask.toolPolicy).toEqual({
      allowedTools: ["skill", "read", "apply_patch", "edit"],
      allowedCapabilities: ["skill", "read", "write"],
      allowedCommands: [],
    });
    expect(skillAbstainTask.toolPolicy).toEqual({
      allowedTools: ["skill", "apply_patch", "edit"],
      allowedCapabilities: ["skill", "write"],
      allowedCommands: [],
    });
    await assertSkillFixture(skillAutoSelectTask, (world, prompt) => {
      expect(prompt).not.toContain(world.ruleToken);
      expect(world.skillNames.every((name) => !prompt.includes(name))).toBe(true);
    });
    await assertSkillFixture(skillAbstainTask, (world, prompt) => {
      expect(prompt).toContain(world.requestedContent.trim());
      expect(world.skillNames.every((name) => !prompt.includes(name))).toBe(true);
    });
  });

  test("accepts exact skill auto-selection evidence and rejects decoy or undeclared reads", () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      skillNames: ["release-handoff", "incident-brief", "dependency-review"],
      skillDescriptions: ["release description", "incident description", "dependency description"],
      selectedSkillName: "release-handoff",
      selectedReferencePath: ".diligent/skills/release-handoff/references/rendering-rule.txt",
      decoyReferencePaths: [
        ".diligent/skills/incident-brief/references/triage-rule.txt",
        ".diligent/skills/dependency-review/references/audit-rule.txt",
      ],
      ruleToken: "opaque-rule",
      expected: "opaque-rule\n",
      expectedHash: "auto-hash",
      protectedPaths: [],
      allowedChanges: ["HANDOFF.txt"],
    };
    const execution = baseExecution(world, "Prepare the handoff.", "Done.");
    execution.providerCalls = [skillProviderCall(world.skillNames, world.skillDescriptions)];
    execution.advertisedTools = [advertisedSkillTools()];
    execution.toolCalls = [
      trace(1, "skill", "skill", { name: world.selectedSkillName }),
      trace(2, "read", "read", { file_path: `$WORKSPACE/${world.selectedReferencePath}` }),
      trace(3, "apply_patch", "write", {
        patch: "*** Begin Patch\n*** Add File: HANDOFF.txt\n+opaque-rule\n*** End Patch",
      }),
    ];
    execution.workspace.final.entries = [{ path: "HANDOFF.txt", kind: "file", size: 1, sha256: "auto-hash" }];
    expect(skillAutoSelectTask.evaluate(execution)).toEqual({ passed: true });
    const directCreate = structuredClone(execution.toolCalls[2]!);
    const missingFileError = "Error reading file: ENOENT: no such file or directory, open '$WORKSPACE/HANDOFF.txt'";
    const failedEdit = trace(3, "edit", "write", {
      file_path: "$WORKSPACE/HANDOFF.txt",
      old_string: "placeholder",
      new_string: "placeholder",
      replace_all: false,
    });
    failedEdit.outcome = "runtime_error";
    failedEdit.error = missingFileError;
    failedEdit.output = { output: missingFileError, metadata: { error: true } };
    failedEdit.threadId = "thread-1";
    const recoveredCreate = trace(4, "edit", "write", {
      file_path: "$WORKSPACE/HANDOFF.txt",
      old_string: "",
      new_string: world.expected,
      replace_all: false,
    });
    recoveredCreate.threadId = "thread-1";
    execution.toolCalls.splice(2, 1, failedEdit, recoveredCreate);
    expect(skillAutoSelectTask.evaluate(execution)).toEqual({ passed: true });
    (failedEdit.input as { old_string: string }).old_string = "different-placeholder";
    expect(skillAutoSelectTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "skill_auto_select.wrong_write",
    });
    (failedEdit.input as { old_string: string }).old_string = "placeholder";
    execution.profile.provider = "openai";
    expect(skillAutoSelectTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "skill_auto_select.wrong_write",
    });
    execution.profile.provider = "anthropic";
    execution.toolCalls.splice(2, 2, directCreate);
    (execution.toolCalls[2]!.input as { patch: string }).patch += "\n";
    expect(skillAutoSelectTask.evaluate(execution)).toEqual({ passed: true });
    (execution.toolCalls[2]!.input as { patch: string }).patch = (
      execution.toolCalls[2]!.input as { patch: string }
    ).patch.trimEnd();
    execution.toolCalls[0] = trace(1, "skill", "skill", { name: world.skillNames[1] });
    expect(skillAutoSelectTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[0] = trace(1, "skill", "skill", { name: world.selectedSkillName });
    execution.toolCalls.splice(
      2,
      0,
      trace(3, "read", "read", { file_path: `$WORKSPACE/${world.decoyReferencePaths[0]}` }),
    );
    expect(skillAutoSelectTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls.splice(2, 1);
    execution.toolCalls[0]!.outcome = "runtime_error";
    expect(skillAutoSelectTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[0]!.outcome = "success";
    execution.verifier!.exitCode = 1;
    expect(skillAutoSelectTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.exitCode = 0;
    execution.workspace.final.entries[0]!.sha256 = "wrong-hash";
    expect(skillAutoSelectTask.evaluate(execution).passed).toBe(false);
  });

  test("accepts advertised skill abstention and rejects any skill use or skill-path read", () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      skillNames: ["release-handoff", "incident-brief", "dependency-review"],
      skillDescriptions: ["release description", "incident description", "dependency description"],
      skillPaths: [
        ".diligent/skills/release-handoff/SKILL.md",
        ".diligent/skills/incident-brief/SKILL.md",
        ".diligent/skills/dependency-review/SKILL.md",
      ],
      referencePaths: [
        ".diligent/skills/release-handoff/references/template.txt",
        ".diligent/skills/incident-brief/references/template.txt",
        ".diligent/skills/dependency-review/references/template.txt",
      ],
      requestedContent: "status=ready\n",
      expected: "status=ready\n",
      expectedHash: "abstain-hash",
      protectedPaths: [],
      allowedChanges: ["STATUS.txt"],
    };
    const execution = baseExecution(world, "Write status=ready to STATUS.txt.", "Done.");
    execution.providerCalls = [skillProviderCall(world.skillNames, world.skillDescriptions)];
    execution.advertisedTools = [advertisedSkillTools()];
    execution.toolCalls = [
      trace(1, "apply_patch", "write", {
        patch: "*** Begin Patch\n*** Add File: STATUS.txt\n+status=ready\n*** End Patch",
      }),
    ];
    execution.workspace.final.entries = [{ path: "STATUS.txt", kind: "file", size: 1, sha256: "abstain-hash" }];
    expect(skillAbstainTask.evaluate(execution)).toEqual({ passed: true });
    (execution.toolCalls[0]!.input as { patch: string }).patch += "\n";
    expect(skillAbstainTask.evaluate(execution)).toEqual({ passed: true });
    (execution.toolCalls[0]!.input as { patch: string }).patch = (
      execution.toolCalls[0]!.input as { patch: string }
    ).patch.trimEnd();
    execution.toolCalls.unshift(trace(1, "skill", "skill", { name: world.skillNames[0] }));
    expect(skillAbstainTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls.shift();
    execution.toolCalls.unshift(trace(1, "read", "read", { file_path: `$WORKSPACE/${world.skillPaths[0]}` }));
    expect(skillAbstainTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls.shift();
    execution.verifier!.exitCode = 1;
    expect(skillAbstainTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.exitCode = 0;
    execution.workspace.final.entries[0]!.sha256 = "wrong-hash";
    expect(skillAbstainTask.evaluate(execution).passed).toBe(false);
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

  test("defines a seeded record-selection update without prescribing a tool sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-file-roundtrip-"));
    try {
      const world = await fileRoundtripTask.setup("shared-seed-123", root);
      expect(fileRoundtripTask.toolPolicy.allowedCapabilities).toEqual(["read", "write"]);
      expect(JSON.stringify(fileRoundtripTask.createSteps(world))).not.toContain(world.selectedRecordId);
      expect(JSON.stringify(fileRoundtripTask.createSteps(world))).not.toContain(world.pendingStatus);
      expect(world.recordPaths).toHaveLength(3);
      expect(world.allowedChanges).toEqual([world.selectedPath]);
      expect(world.protectedPaths).toContain(world.indexPath);
      expect(fileRoundtripTask.limits.maxToolCalls).toBeGreaterThan(3);
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

  test("defines deterministic knowledge intent-split and forget fixtures", async () => {
    const splitRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-intent-split-"));
    const forgetRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-forget-"));
    try {
      const split = await knowledgeIntentSplitTask.setup("shared-seed-123", splitRoot);
      const forget = await knowledgeForgetTask.setup("shared-seed-123", forgetRoot);
      const splitPrompt = JSON.stringify(knowledgeIntentSplitTask.createSteps(split));
      const forgetPrompt = JSON.stringify(knowledgeForgetTask.createSteps(forget));
      expect(knowledgeIntentSplitTask.toolPolicy).toEqual({
        allowedTools: ["search_knowledge", "update_knowledge", "apply_patch", "edit"],
        allowedCapabilities: ["knowledge", "write"],
        allowedCommands: [],
      });
      expect(knowledgeForgetTask.toolPolicy).toEqual(knowledgeIntentSplitTask.toolPolicy);
      expect(splitPrompt).toContain(split.knowledgeId);
      expect(splitPrompt).toContain(split.durableValue);
      expect(splitPrompt).toContain(split.transientValue);
      expect(splitPrompt).not.toContain("search_knowledge");
      expect(splitPrompt).not.toContain("update_knowledge");
      expect(forgetPrompt).toContain(forget.knowledgeId);
      expect(forgetPrompt).toContain(forget.taskValue);
      expect(forgetPrompt).not.toContain("search_knowledge");
      expect(forgetPrompt).not.toContain("update_knowledge");
      expect(split.allowedChanges).toEqual(["CURRENT.txt"]);
      expect(forget.allowedChanges).toEqual(["FORGET.txt"]);
      expect(split.protectedPaths).toEqual([]);
      expect(forget.protectedPaths).toEqual([]);
      expect(knowledgeIntentSplitTask.limits.maxUserInputRequests).toBe(0);
      expect(knowledgeIntentSplitTask.limits.maxChildAgents).toBe(0);
      expect(knowledgeForgetTask.limits.maxUserInputRequests).toBe(0);
      expect(knowledgeForgetTask.limits.maxChildAgents).toBe(0);
    } finally {
      await removeTemporaryRoot(splitRoot);
      await removeTemporaryRoot(forgetRoot);
    }
  });

  test("independently rejects transient knowledge leakage and forgotten-value replacement", async () => {
    const splitRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-split-verifier-"));
    const forgetRoot = await mkdtemp(join(tmpdir(), "diligent-runtime-knowledge-forget-verifier-"));
    try {
      const split = await knowledgeIntentSplitTask.setup("shared-seed-123", splitRoot);
      const updatedEntry = {
        id: split.knowledgeId,
        timestamp: "2026-07-18T02:00:00.000Z",
        type: "preference",
        content: split.content,
        confidence: 0.7,
        tags: split.tags,
      };
      await writeFixture(splitRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(updatedEntry)}\n`,
        "CURRENT.txt": split.expected,
      });
      expect((await knowledgeIntentSplitTask.verify!(split, new AbortController().signal)).exitCode).toBe(0);
      updatedEntry.tags = ["review-audience"];
      await writeFixture(splitRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(updatedEntry)}\n`,
      });
      expect((await knowledgeIntentSplitTask.verify!(split, new AbortController().signal)).exitCode).toBe(0);
      updatedEntry.tags = [split.transientValue];
      await writeFixture(splitRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(updatedEntry)}\n`,
      });
      expect((await knowledgeIntentSplitTask.verify!(split, new AbortController().signal)).exitCode).toBe(1);
      updatedEntry.tags = ["review-audience"];
      await writeFixture(splitRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(updatedEntry)}\n${JSON.stringify({
          ...updatedEntry,
          id: "preference.transient-duplicate",
          content: `Current-only value is ${split.transientValue}.`,
        })}\n`,
      });
      expect((await knowledgeIntentSplitTask.verify!(split, new AbortController().signal)).exitCode).toBe(1);

      const forget = await knowledgeForgetTask.setup("shared-seed-123", forgetRoot);
      await writeFixture(forgetRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(forget.controlEntry)}\n`,
        "FORGET.txt": forget.expected,
      });
      expect((await knowledgeForgetTask.verify!(forget, new AbortController().signal)).exitCode).toBe(0);
      await writeFixture(forgetRoot, {
        ".diligent/knowledge/knowledge.jsonl": `${JSON.stringify(forget.controlEntry)}\n${JSON.stringify({
          id: "preference.replacement",
          timestamp: "2026-07-18T02:00:00.000Z",
          type: "preference",
          content: forget.targetContent,
          confidence: 0.8,
        })}\n`,
      });
      expect((await knowledgeForgetTask.verify!(forget, new AbortController().signal)).exitCode).toBe(1);
    } finally {
      await removeTemporaryRoot(splitRoot);
      await removeTemporaryRoot(forgetRoot);
    }
  });

  test("accepts exact knowledge intent split and rejects trace, store, and output violations", () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      knowledgeId: "preference.review-audience",
      durableValue: "AUDIENCE_future",
      transientValue: "CURRENT_once",
      content: "Preferred review audience is AUDIENCE_future.",
      tags: ["review", "audience"],
      expected: "CURRENT_once\n",
      expectedHash: "split-hash",
      protectedPaths: [],
      allowedChanges: ["CURRENT.txt"],
    };
    const execution = baseExecution(world, "Remember one value and write another.", "Done.");
    execution.profile.provider = "openai";
    execution.toolCalls = [
      trace(1, "search_knowledge", "knowledge", { id: world.knowledgeId }),
      trace(2, "update_knowledge", "knowledge", {
        action: "upsert",
        id: world.knowledgeId,
        type: "preference",
        content: world.content,
        tags: world.tags,
      }),
      trace(3, "apply_patch", "write", {
        patch: "*** Begin Patch\n*** Add File: CURRENT.txt\n+CURRENT_once\n*** End Patch",
      }),
    ];
    execution.workspace.final.entries = [{ path: "CURRENT.txt", kind: "file", size: 1, sha256: "split-hash" }];
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    const splitBaseline = structuredClone(execution.toolCalls);
    execution.toolCalls.shift();
    execution.toolCalls[0]!.sequence = 1;
    execution.toolCalls[1]!.sequence = 2;
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    (execution.toolCalls[0]!.input as { tags?: string[] }).tags = ["review-audience"];
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    delete (execution.toolCalls[0]!.input as { tags?: string[] }).tags;
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    (execution.toolCalls[0]!.input as { tags?: string[] }).tags = [world.transientValue];
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls = structuredClone(splitBaseline);
    execution.toolCalls[0]!.sequence = 2;
    execution.toolCalls[0]!.input = { query: "review audience" };
    execution.toolCalls[1]!.sequence = 1;
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[0]!.input = { query: world.transientValue };
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls = structuredClone(splitBaseline);
    (execution.toolCalls[2]!.input as { patch: string }).patch += "\n";
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls = splitBaseline;
    execution.profile.provider = "anthropic";
    execution.toolCalls[2] = trace(3, "edit", "write", {
      file_path: "$WORKSPACE/CURRENT.txt",
      old_string: "",
      new_string: world.expected,
      replace_all: false,
    });
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    execution.profile.provider = "openai";
    execution.toolCalls[2] = trace(3, "apply_patch", "write", {
      patch: "*** Begin Patch\n*** Add File: CURRENT.txt\n+CURRENT_once\n*** End Patch",
    });
    [execution.toolCalls[0], execution.toolCalls[1]] = [execution.toolCalls[1]!, execution.toolCalls[0]!];
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({ passed: true });
    [execution.toolCalls[0], execution.toolCalls[1]] = [execution.toolCalls[1]!, execution.toolCalls[0]!];
    execution.toolCalls[0]!.input = { id: "wrong-id" };
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[0]!.input = { id: world.knowledgeId };
    (execution.toolCalls[1]!.input as Record<string, unknown>).action = "delete";
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    (execution.toolCalls[1]!.input as Record<string, unknown>).action = "upsert";
    execution.verifier!.exitCode = 1;
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.exitCode = 0;
    execution.verifier!.timedOut = true;
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.timedOut = false;
    execution.toolCalls.splice(2, 0, trace(3, "search_knowledge", "knowledge", { id: world.knowledgeId }));
    expect(knowledgeIntentSplitTask.evaluate(execution)).toEqual({
      passed: true,
      diagnostics: [
        {
          dimension: "efficiency",
          code: "knowledge_intent_split.second_safe_search",
          message: "A second bounded read-only knowledge search was used before successful completion.",
        },
      ],
    });
    execution.toolCalls.splice(2, 0, trace(3, "search_knowledge", "knowledge", { query: "review audience" }));
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls.splice(2, 2);
    execution.workspace.final.entries[0]!.sha256 = "wrong-hash";
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
    execution.workspace.final.entries[0]!.sha256 = world.expectedHash;
    execution.toolCalls[1]!.outcome = "runtime_error";
    expect(knowledgeIntentSplitTask.evaluate(execution).passed).toBe(false);
  });

  test("accepts exact knowledge deletion and rejects wrong deletion or replacement evidence", () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      knowledgeId: "preference.deploy-window",
      forgottenValue: "WINDOW_old",
      targetContent: "Preferred deployment window is WINDOW_old.",
      taskValue: "TASK_once",
      controlEntry: {
        id: "preference.control",
        timestamp: "2026-07-18T00:00:00.000Z",
        type: "preference" as const,
        content: "Control preference remains CONTROL_keep.",
        confidence: 0.9,
        tags: ["control"],
      },
      expected: "TASK_once\n",
      expectedHash: "forget-hash",
      protectedPaths: [],
      allowedChanges: ["FORGET.txt"],
    };
    const execution = baseExecution(world, "Forget one preference and write a separate value.", "Done.");
    execution.toolCalls = [
      trace(1, "search_knowledge", "knowledge", { id: world.knowledgeId }),
      trace(2, "update_knowledge", "knowledge", { action: "delete", id: world.knowledgeId }),
      trace(3, "edit", "write", {
        file_path: "$WORKSPACE/FORGET.txt",
        old_string: "",
        new_string: world.expected,
        replace_all: false,
      }),
    ];
    execution.workspace.final.entries = [{ path: "FORGET.txt", kind: "file", size: 1, sha256: "forget-hash" }];
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[0]!.input = { id: world.knowledgeId, query: "deployment window" };
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[0]!.input = { id: "wrong-id", query: "deployment window" };
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[0]!.input = { id: world.knowledgeId };
    const directDeleteCalls = structuredClone(execution.toolCalls);
    directDeleteCalls.shift();
    directDeleteCalls[0]!.sequence = 1;
    directDeleteCalls[1]!.sequence = 2;
    execution.toolCalls = directDeleteCalls;
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls = [
      trace(1, "search_knowledge", "knowledge", { id: world.knowledgeId }),
      trace(2, "update_knowledge", "knowledge", { action: "delete", id: world.knowledgeId }),
      trace(3, "edit", "write", {
        file_path: "$WORKSPACE/FORGET.txt",
        old_string: "",
        new_string: world.expected,
        replace_all: false,
      }),
    ];
    execution.profile.provider = "openai";
    execution.toolCalls[2] = trace(3, "apply_patch", "write", {
      patch: "*** Begin Patch\n*** Add File: FORGET.txt\n+TASK_once\n*** End Patch",
    });
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    const forgetBaseline = structuredClone(execution.toolCalls);
    execution.toolCalls[1]!.sequence = 3;
    execution.toolCalls[2]!.sequence = 2;
    [execution.toolCalls[1], execution.toolCalls[2]] = [execution.toolCalls[2]!, execution.toolCalls[1]!];
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls = structuredClone(forgetBaseline);
    (execution.toolCalls[2]!.input as { patch: string }).patch += "\n";
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls = forgetBaseline;
    execution.toolCalls[1]!.sequence = 3;
    execution.toolCalls[2]!.sequence = 4;
    execution.toolCalls.splice(1, 0, trace(2, "search_knowledge", "knowledge", { query: "deployment window" }));
    expect(knowledgeForgetTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[1]!.input = { query: world.taskValue };
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls = structuredClone(forgetBaseline);
    execution.profile.provider = "anthropic";
    execution.toolCalls[2] = trace(3, "edit", "write", {
      file_path: "$WORKSPACE/FORGET.txt",
      old_string: "",
      new_string: world.expected,
      replace_all: false,
    });
    execution.toolCalls[0]!.sequence = 3;
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[0]!.sequence = 1;
    execution.toolCalls[1]!.input = { action: "upsert", id: world.knowledgeId };
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[1]!.input = { action: "delete", id: "wrong-id" };
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[1]!.input = { action: "delete", id: world.knowledgeId };
    execution.toolCalls.push(trace(4, "update_knowledge", "knowledge", { action: "delete", id: world.knowledgeId }));
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls.pop();
    execution.verifier!.exitCode = 1;
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.exitCode = 0;
    execution.verifier!.timedOut = true;
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.verifier!.timedOut = false;
    execution.workspace.final.entries[0]!.sha256 = "wrong-hash";
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.workspace.final.entries[0]!.sha256 = world.expectedHash;
    execution.toolCalls[0]!.outcome = "runtime_error";
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[0]!.outcome = "success";
    execution.toolCalls[1]!.outcome = "runtime_error";
    expect(knowledgeForgetTask.evaluate(execution).passed).toBe(false);
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

  test("keeps every first-tranche opaque fixture fact out of its client prompts", async () => {
    const tasks: readonly AnyRuntimeEvalTask[] = [
      instructionHierarchyTask,
      planConvergeTask,
      executeAutonomousTask,
      planProgressTask,
      hookContextFollowTask,
    ];
    for (const task of tasks) {
      const root = await mkdtemp(join(tmpdir(), `diligent-runtime-${task.id}-`));
      try {
        const world = await task.setup("shared-seed-123", root);
        const prompts = JSON.stringify(task.createSteps(world));
        const config = await task.createRuntimeConfig(world, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          effort: "medium",
        });
        const opaqueValues =
          task.id === "instruction-hierarchy"
            ? [world.target, world.rootMarker, world.nestedMarker]
            : task.id === "plan-converge"
              ? [world.apiFact, world.uiFact, world.preference]
              : task.id === "execute-autonomous"
                ? [world.marker]
                : task.id === "plan-progress"
                  ? [world.base, world.middle, world.final, ...world.planSteps]
                  : [world.hookFact, world.injectedContext];
        expect(opaqueValues.every((value) => typeof value === "string" && !prompts.includes(value))).toBe(true);
        expect(task.statePolicy).toBeDefined();
        expect(config.skills.every((skill) => skill.path.startsWith(root))).toBe(true);
        expect(task.limits.maxTurns).toBeGreaterThan(0);
        expect(task.limits.maxToolCalls).toBeGreaterThan(0);
      } finally {
        await removeTemporaryRoot(root);
      }
    }
  });

  test("keeps plan-progress opaque inputs out of its verifier source", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-plan-progress-verifier-"));
    try {
      const world = await planProgressTask.setup("shared-seed-123", root);
      const verifierSource = await readFile(join(root, "test/pipeline.test.ts"), "utf8");
      expect(verifierSource).toContain("inputs/base.txt");
      expect(verifierSource).toContain("inputs/suffixes.txt");
      expect([world.base, world.middle, world.final].every((value) => !verifierSource.includes(value))).toBe(true);
      const prompt = JSON.stringify(planProgressTask.createSteps(world));
      expect(prompt).toContain("inputs/base.txt");
      expect(prompt).toContain("inputs/suffixes.txt");
      expect(prompt).toContain("read tool");
      expect(prompt).toContain("only permitted shell command is exactly bun test");
      expect([world.base, world.middle, world.final].every((value) => !prompt.includes(value))).toBe(true);
      const boundedProviderNeutralCalls =
        world.planSteps.length + 1 + Object.keys(world.outputs).length + 2 + Object.keys(world.outputs).length + 1 + 6;
      expect(planProgressTask.limits.maxTurns).toBeGreaterThanOrEqual(boundedProviderNeutralCalls);
      expect(planProgressTask.limits.maxToolCalls).toBeGreaterThanOrEqual(boundedProviderNeutralCalls);
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("scores instruction-hierarchy decisions independently of provider prompt plumbing", async () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      cwd: "$WORKSPACE/nested/project",
      target: "payload",
      rootMarker: "root",
      nestedMarker: "nested",
      expected: "root[payload]nested\n",
      expectedHash: "instruction-hash",
      protectedPaths: [],
      allowedChanges: [],
    };
    const execution = baseExecution(world, "Inspect target.txt", "done");
    execution.threadCwd = "$WORKSPACE/nested/project";
    execution.providerCalls = [providerCall(["$WORKSPACE/AGENTS.md", "$WORKSPACE/nested/project/AGENTS.md"], [])];
    execution.toolCalls = [trace(1, "read", "read", { file_path: "$WORKSPACE/nested/project/target.txt" })];
    execution.workspace.final.entries = [
      { path: "nested/project/RESULT.txt", kind: "file", size: 1, sha256: "instruction-hash" },
    ];
    expect(instructionHierarchyTask.evaluate(execution)).toEqual({ passed: true });
    execution.providerCalls = [providerCall(["$WORKSPACE/AGENTS.md"], [])];
    expect(instructionHierarchyTask.evaluate(execution)).toEqual({ passed: true });
  });

  test("accepts repeated fact references, but rejects missing facts or a question before discovery", async () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      apiFact: "api-hidden",
      uiFact: "ui-hidden",
      preference: "preference-hidden",
      expected: "",
      protectedPaths: [],
      allowedChanges: [],
    };
    const finalText =
      `<proposed_plan>\n${world.apiFact}\n${world.uiFact}\n${world.preference}\n` +
      `Validate ${world.apiFact} with ${world.uiFact} under ${world.preference}.\n</proposed_plan>`;
    const askedQuestion = {
      id: "rollout_preference",
      header: "Rollout",
      question: "Which rollout preference should the plan use?",
      options: [{ label: "Custom", description: "Supply the unavailable rollout preference." }],
    };
    const execution = baseExecution(world, "plan", finalText);
    execution.toolCalls = [
      trace(1, "read", "read", { file_path: "$WORKSPACE/facts/api.txt" }),
      trace(2, "read", "read", { file_path: "$WORKSPACE/facts/ui.txt" }),
      trace(3, "request_user_input", "user_input", { questions: [askedQuestion] }),
    ];
    for (const call of execution.toolCalls) call.threadId = "thread-1";
    execution.toolCalls[0]!.output = { output: world.apiFact };
    execution.toolCalls[1]!.output = { output: world.uiFact };
    execution.toolCalls[2]!.output = { output: `Answer: ${world.preference}` };
    execution.userInputRequests = [
      {
        id: 1,
        method: "userInput/request",
        params: { threadId: "thread-1", request: { questions: [structuredClone(askedQuestion)] } },
      },
    ];
    execution.providerCalls = [providerCall([], ["read", "request_user_input"])];
    expect(planConvergeTask.evaluate(execution)).toEqual({ passed: true });
    execution.turns[0]!.messages = execution.turns[0]!.messages.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            content: message.content.map((block) =>
              block.type === "text" ? { ...block, text: block.text.replaceAll(world.uiFact, "") } : block,
            ),
          }
        : message,
    );
    expect(planConvergeTask.evaluate(execution).passed).toBe(false);
    execution.turns[0]!.messages = baseExecution(world, "plan", finalText).turns[0]!.messages;
    execution.toolCalls[2]!.sequence = 1;
    expect(planConvergeTask.evaluate(execution).passed).toBe(false);
  });

  test("accepts autonomous execute evidence and rejects any clarification request", async () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      marker: "marker",
      operand: 7,
      expected: "source",
      expectedHash: "source-hash",
      protectedPaths: [],
      allowedChanges: [],
    };
    const execution = baseExecution(world, "repair", "Implemented.");
    execution.advertisedTools = [
      {
        sequence: 1,
        turnIndex: 0,
        cwd: "$WORKSPACE",
        mode: "execute",
        provider: "anthropic",
        tools: ["read", "write", "bash"],
      },
    ];
    execution.toolCalls = [trace(1, "write", "write", {}), trace(2, "bash", "execute", { command: "bun test" })];
    execution.toolCalls[1]!.output = { metadata: { exitCode: 0 } };
    execution.workspace.final.entries = [{ path: "src/transform.ts", kind: "file", size: 1, sha256: "source-hash" }];
    expect(executeAutonomousTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[1]!.output = { metadata: { exitCode: 1 } };
    expect(executeAutonomousTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "execute_autonomous.test",
    });
    execution.toolCalls[1]!.output = { metadata: { exitCode: 0 } };
    execution.toolCalls.push(trace(3, "edit", "write", {}));
    expect(executeAutonomousTask.evaluate(execution)).toMatchObject({
      passed: false,
      code: "execute_autonomous.test",
    });
    execution.toolCalls.pop();
    execution.userInputRequests = [userInputRequest("unexpected")];
    expect(executeAutonomousTask.evaluate(execution).passed).toBe(false);
  });

  test("accepts recovered policy rejections and ordered progress, but rejects invalid plan states", async () => {
    const planSteps = [
      "Create generated/stage-one.txt",
      "Create generated/stage-two.txt from stage one",
      "Create generated/stage-three.txt from stage two",
      "Verify the completed pipeline",
    ];
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      base: "base",
      middle: "middle",
      final: "final",
      outputs: {},
      outputHashes: {
        "generated/stage-one.txt": "one",
        "generated/stage-two.txt": "two",
        "generated/stage-three.txt": "three",
      },
      planSteps,
      expected: "",
      protectedPaths: [],
      allowedChanges: [],
    };
    const execution = baseExecution(world, "pipeline", "done");
    const plan = (sequence: number, statuses: string[]) =>
      trace(sequence, "plan", "execute", {
        steps: planSteps.map((text, index) => ({ text, status: statuses[index] })),
      });
    execution.toolCalls = [
      trace(1, "read", "read", { file_path: "$WORKSPACE/inputs/base.txt" }),
      trace(2, "read", "read", { file_path: "$WORKSPACE/inputs/suffixes.txt" }),
      plan(3, ["in_progress", "pending", "pending", "pending"]),
      trace(4, "write", "write", { file_path: "generated/stage-one.txt" }),
      plan(5, ["done", "in_progress", "pending", "pending"]),
      trace(6, "write", "write", { file_path: "generated/stage-two.txt" }),
      plan(7, ["done", "done", "in_progress", "pending"]),
      trace(8, "write", "write", { file_path: "generated/stage-three.txt" }),
      plan(9, ["done", "done", "done", "in_progress"]),
      trace(10, "bash", "execute", { command: "bun test" }),
      plan(11, ["done", "done", "done", "done"]),
    ];
    execution.toolCalls[9]!.output = { metadata: { exitCode: 0 } };
    execution.workspace.final.entries = [
      { path: "generated/stage-one.txt", kind: "file", size: 1, sha256: "one" },
      { path: "generated/stage-two.txt", kind: "file", size: 1, sha256: "two" },
      { path: "generated/stage-three.txt", kind: "file", size: 1, sha256: "three" },
    ];
    expect(planProgressTask.evaluate(execution)).toEqual({ passed: true });
    for (const call of execution.toolCalls) call.sequence += 2;
    const rejectedProbe = trace(1, "bash", "execute", { command: "ls" });
    rejectedProbe.outcome = "policy_rejection";
    const failedPreflight = trace(2, "bash", "execute", { command: "bun test" });
    failedPreflight.output = { metadata: { exitCode: 1 } };
    execution.toolCalls.unshift(rejectedProbe, failedPreflight);
    expect(planProgressTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls.splice(0, 2);
    for (const call of execution.toolCalls) call.sequence -= 2;
    const baselineToolCalls = structuredClone(execution.toolCalls);
    execution.toolCalls[9]!.output = { metadata: { exitCode: 1 } };
    expect(planProgressTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls = structuredClone(baselineToolCalls);
    const finalPlan = execution.toolCalls.pop()!;
    execution.toolCalls[9]!.output = { metadata: { exitCode: 1 } };
    execution.toolCalls.push(
      plan(11, ["done", "in_progress", "pending", "pending"]),
      trace(12, "write", "write", { file_path: "generated/stage-two.txt" }),
      plan(13, ["done", "done", "in_progress", "pending"]),
      trace(14, "write", "write", { file_path: "generated/stage-three.txt" }),
      plan(15, ["done", "done", "done", "in_progress"]),
    );
    const recoveredTest = trace(16, "bash", "execute", { command: "bun test" });
    recoveredTest.output = { metadata: { exitCode: 0 } };
    execution.toolCalls.push(recoveredTest, { ...finalPlan, sequence: 17 });
    expect(planProgressTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls[9]!.output = { metadata: { exitCode: 0 } };
    expect(planProgressTask.evaluate(execution)).toEqual({
      passed: false,
      code: "plan_progress.regression",
      message: "Completed plan progress regressed without a failed verification in the preceding plan interval.",
      dimension: "behavior",
    });
    execution.toolCalls[9]!.output = {};
    expect(planProgressTask.evaluate(execution)).toMatchObject({ passed: false, code: "plan_progress.regression" });
    execution.toolCalls = baselineToolCalls;
    execution.toolCalls[2] = plan(3, ["in_progress", "in_progress", "pending", "pending"]);
    expect(planProgressTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls[2] = plan(3, ["in_progress", "pending", "pending", "pending"]);
    execution.toolCalls[4] = plan(5, ["in_progress", "pending", "pending", "pending"]);
    expect(planProgressTask.evaluate(execution).passed).toBe(false);
  });

  test("scores hook-follow behavior independently of provider-context plumbing", async () => {
    const world = {
      root: "$WORKSPACE",
      seed: "seed",
      hookFact: "hook-hidden",
      injectedContext: "HOOK_VALUE=hook-hidden",
      clientPrompt: "Use submission context.",
      expected: "hook-hidden\n",
      expectedHash: "hook-hash",
      protectedPaths: [],
      allowedChanges: [],
    };
    const execution = baseExecution(world, world.clientPrompt, "done");
    execution.session.lines = [
      { id: "thread-1" },
      { type: "message", message: { role: "user", content: `${world.injectedContext}\n\n${world.clientPrompt}` } },
    ];
    execution.providerCalls = [providerCall([], ["write"], `${world.injectedContext}\n\n${world.clientPrompt}`)];
    execution.toolCalls = [trace(1, "write", "write", { file_path: "HOOK.txt" })];
    execution.workspace.final.entries = [{ path: "HOOK.txt", kind: "file", size: 1, sha256: "hook-hash" }];
    expect(hookContextFollowTask.evaluate(execution)).toEqual({ passed: true });
    const failedCreate = trace(1, "edit", "write", { file_path: "HOOK.txt" });
    failedCreate.outcome = "runtime_error";
    execution.toolCalls[0]!.sequence = 2;
    execution.toolCalls.unshift(failedCreate);
    expect(hookContextFollowTask.evaluate(execution)).toEqual({ passed: true });
    execution.toolCalls.push(trace(3, "read", "read", { file_path: "HOOK.txt" }));
    expect(hookContextFollowTask.evaluate(execution).passed).toBe(false);
    execution.toolCalls = [trace(1, "write", "write", { file_path: "HOOK.txt" })];
    execution.providerCalls = [providerCall([], ["write"], world.clientPrompt)];
    expect(hookContextFollowTask.evaluate(execution)).toEqual({ passed: true });
  });
});

function baseExecution<T>(world: T, clientPrompt: string, assistantText: string): RuntimeEvalExecution<T> {
  return {
    taskId: "test",
    profile: { provider: "anthropic", model: "test-model", effort: "medium" },
    seed: "seed",
    startedAt: new Date(0).toISOString(),
    elapsedMs: 1,
    termination: "completed",
    turns: [
      {
        index: 0,
        threadId: "thread-1",
        clientPrompt,
        startedAt: new Date(0).toISOString(),
        elapsedMs: 1,
        termination: "completed",
        coreEvents: [],
        runtimeEvents: [],
        notifications: [],
        messages: [assistant(assistantText)],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
    compactions: [],
    threadCwd: "$WORKSPACE",
    advertisedTools: [],
    threadReads: [],
    protocolActions: [],
    providerCalls: [],
    toolCalls: [],
    toolOutputFiles: [],
    approvals: [],
    userInputRequests: [],
    logs: [],
    session: { threadId: "thread-1", lines: [{ id: "thread-1" }] },
    childSessions: [],
    workspace: { initial: { entries: [] }, final: { entries: [] } },
    runtimeState: { initial: [], final: [], diff: [] },
    verifier: { argv: [], exitCode: 0, elapsedMs: 1, stdout: "", stderr: "", timedOut: false },
    world,
  };
}

async function assertSkillFixture<T extends RuntimeFixtureWorld & { skillNames: string[] }>(
  task: RuntimeEvalTask<T>,
  checkPrompt: (world: T, prompt: string) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `diligent-runtime-${task.id}-`));
  try {
    const world = await task.setup("shared-seed-123", root);
    const prompt = JSON.stringify(task.createSteps(world));
    const config = await task.createRuntimeConfig(world, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      effort: "medium",
    });
    expect(new Set(config.skills.map((skill) => skill.name))).toEqual(new Set(world.skillNames));
    expect(config.skills.every((skill) => skill.path.startsWith(root))).toBe(true);
    expect(task.statePolicy).toEqual({ allowedMutations: ["infrastructure", "sessions"] });
    expect(task.limits.maxTurns).toBeGreaterThan(0);
    expect(task.limits.maxToolCalls).toBeGreaterThan(0);
    expect(world.protectedPaths.every((path) => path.startsWith(".diligent/skills/"))).toBe(true);
    checkPrompt(world, prompt);
  } finally {
    await removeTemporaryRoot(root);
  }
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    model: {
      provider: "anthropic" as const,
      modelId: "test-model",
      contextWindow: 100_000,
      maxOutputTokens: 8_192,
      supportsThinking: false,
    },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn" as const,
    timestamp: 0,
  };
}

function trace(
  sequence: number,
  name: string,
  capability: RuntimeToolTrace["capability"],
  input: unknown,
): RuntimeToolTrace {
  return { sequence, toolCallId: `tool-${sequence}`, name, capability, input, outcome: "success" };
}

function providerCall(instructionPaths: string[], toolNames: string[], message = "") {
  return {
    sequence: 1,
    model: { provider: "anthropic", modelId: "test-model" },
    systemPrompt: {
      totalCount: instructionPaths.length,
      includedCount: instructionPaths.length,
      omittedCount: 0,
      items: instructionPaths.map((path) => ({ tagAttributes: { path } })),
    },
    messages: { totalCount: 1, includedCount: 1, omittedCount: 0, items: [message] },
    tools: {
      totalCount: toolNames.length,
      includedCount: toolNames.length,
      omittedCount: 0,
      items: toolNames.map((name) => ({ name, description: "", inputSchema: {} })),
    },
    streamOptions: {},
    bounds: {
      maxSourceItems: 1,
      maxNestedItems: 1,
      maxObjectProperties: 1,
      maxStringChars: 1,
      maxDepth: 1,
      truncatedStrings: 0,
      omittedNestedItems: 0,
      omittedObjectProperties: 0,
    },
  } as unknown as RuntimeEvalExecution<unknown>["providerCalls"][number];
}

function skillProviderCall(skillNames: string[], descriptions: string[]) {
  const call = providerCall([], ["skill", "write"]);
  call.systemPrompt = {
    totalCount: 1,
    includedCount: 1,
    omittedCount: 0,
    items: [
      {
        label: "skills",
        content: skillNames.map((name, index) => `- **${name}**: ${descriptions[index]}`).join("\n"),
      },
    ],
  } as never;
  call.tools.items[0] = {
    kind: "function",
    name: "skill",
    description: skillNames.map((name, index) => `- ${name}: ${descriptions[index]}`).join("\n"),
    inputSchema: {},
  } as never;
  return call;
}

function advertisedSkillTools() {
  return {
    sequence: 1,
    turnIndex: 0,
    cwd: "$WORKSPACE",
    mode: "default" as const,
    provider: "anthropic" as const,
    tools: ["skill", "read", "apply_patch"],
  };
}

function userInputRequest(id: string) {
  return { method: "userInput/request", params: { request: { questions: [{ id }] } } };
}
