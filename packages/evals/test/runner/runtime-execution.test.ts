// @summary Deterministic end-to-end test for the in-process runtime eval adapter and cleanup

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AssistantMessage, Message } from "@diligent/core/message-contract";
import type { StreamFunction } from "@diligent/core/provider-contract";
import { runRuntimeEvalExecution } from "../../src/runner/runtime-execution";
import type { RuntimeEvalExecution, RuntimeEvalTask } from "../../src/runtime-task";
import {
  clarifyThenExecuteTask,
  collaborationDelegationTask,
  fileRoundtripTask,
  knowledgeRecallTask,
  knowledgeUpdateTask,
  manualCompactionResumeTask,
  planToExecuteTask,
  type ReadImagePairWorld,
  readImagePairTask,
} from "../../src/tasks/runtime";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  type RuntimeFixtureWorld,
  seededToken,
  writeFixture,
} from "../../src/tasks/runtime/helpers";
import { assistantMessage, hangingStream, sequenceStream } from "../helpers/fake-stream";

describe("runRuntimeEvalExecution", () => {
  test("compacts, restarts, and resumes with the compacted facts", async () => {
    const seed = "shared-seed-123";
    const alpha = seededToken(seed, "ALPHA");
    const beta = seededToken(seed, "BETA");
    const result = await runRuntimeEvalExecution({
      task: manualCompactionResumeTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage([{ type: "text", text: "ACK" }]),
        assistantMessage([{ type: "text", text: `Retain alpha ${alpha} and beta ${beta} for the resumed task.` }]),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-context",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: CONTEXT.json\n+{"alpha":"${alpha}","beta":"${beta}"}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.compactions).toHaveLength(1);
    expect(result.execution.compactions[0]?.response.compacted).toBe(true);
    expect(result.execution.session.lines.some((line) => (line as { type?: string }).type === "compaction")).toBe(true);
  });

  test("uses a scripted user-input answer in a later default-mode write", async () => {
    const seed = "shared-seed-123";
    const answer = seededToken(seed, "TARGET");
    const result = await runRuntimeEvalExecution({
      task: clarifyThenExecuteTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "ask-target",
              name: "request_user_input",
              input: {
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
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "RECEIVED" }]),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-target",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: TARGET.txt\n+${answer}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.userInputRequests).toHaveLength(1);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["request_user_input", "apply_patch"]);
    expect(JSON.stringify(result.execution.session.lines)).toContain(answer);
  });

  test("executes the plan-to-default task and verifies its exact implementation", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "PLAN");
    const operand = (Number.parseInt(seed.slice(0, 4), 36) % 7) + 2;
    const result = await runRuntimeEvalExecution({
      task: planToExecuteTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "glob-1", name: "glob", input: { pattern: "src/value.ts" } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: `FIX=WRONG_OPERATOR; TOKEN=${token}` }]),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-1",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Update File: src/value.ts\n@@\n export function adjustValue(value: number): number {\n-  return value - ${operand};\n+  return value + ${operand};\n }\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage(
          [{ type: "tool_call", id: "bash-1", name: "bash", input: { command: "bun test" } }],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Implemented and verified." }]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.turns).toHaveLength(2);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["glob", "apply_patch", "bash"]);
  });

  test("executes the knowledge-recall task through the assembled runtime", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "CHANNEL");
    const result = await runRuntimeEvalExecution({
      task: knowledgeRecallTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "patch-1",
              name: "apply_patch",
              input: {
                patch: `*** Begin Patch\n*** Add File: RELEASE.txt\n+${token}\n*** End Patch`,
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "Done." }]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["apply_patch"]);
  });

  test("executes stable-id knowledge search and update with final-store verification", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "MARKER");
    const knowledgeId = "preference.response-marker";
    const content = `Preferred response marker is ${token}.`;
    const result = await runRuntimeEvalExecution({
      task: knowledgeUpdateTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([
        assistantMessage(
          [{ type: "tool_call", id: "search-1", name: "search_knowledge", input: { id: knowledgeId } }],
          "tool_use",
        ),
        assistantMessage(
          [
            {
              type: "tool_call",
              id: "update-1",
              name: "update_knowledge",
              input: {
                action: "upsert",
                id: knowledgeId,
                type: "preference",
                content,
                tags: ["response-marker"],
              },
            },
          ],
          "tool_use",
        ),
        assistantMessage([{ type: "text", text: "ACK" }]),
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["search_knowledge", "update_knowledge"]);
    expect(result.execution.verifier?.exitCode).toBe(0);
  });

  test("reads a seed-swapped image pair while omitting raw base64 from all evidence", async () => {
    const seed = "shared-seed-123";
    const swap = createHash("sha256").update(seed).digest()[0]! % 2 === 1;
    const expected = swap ? "A=BLUE; B=RED" : "A=RED; B=BLUE";
    const result = await runRuntimeEvalExecution({
      task: readImagePairTask,
      seed,
      profile: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
      streamFunction: imagePairStream(expected),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => call.toolCallId)).toEqual(["image-a", "image-b"]);
    expect(JSON.stringify(result.execution)).not.toContain("iVBOR");
    expect(JSON.stringify(result.execution)).toContain("[base64 omitted]");

    const withoutRuntimeImages = structuredClone(result.execution);
    for (const turn of withoutRuntimeImages.turns) {
      turn.runtimeEvents = turn.runtimeEvents.map((event) => {
        const item = event as { type?: string; toolName?: string; outputImages?: unknown };
        if (item.type !== "tool_end" || item.toolName !== "read_image") return event;
        const { outputImages: _omitted, ...rest } = item;
        return rest;
      });
    }
    expect(readImagePairTask.evaluate(withoutRuntimeImages as RuntimeEvalExecution<ReadImagePairWorld>).passed).toBe(
      false,
    );
  });

  test("attributes a protected read to one completed child with a linked session", async () => {
    const seed = "shared-seed-123";
    const token = seededToken(seed, "VALUE");
    const result = await runRuntimeEvalExecution({
      task: collaborationDelegationTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: collaborationStream(token),
    });

    expect(
      result.execution.turns
        .flatMap((turn) => turn.runtimeEvents)
        .flatMap((event) => {
          const item = event as { type?: string; status?: string };
          return item.type === "collab_spawn_end" ? [item.status] : [];
        }),
    ).toEqual(["running", "completed"]);
    expect(result.execution.turns).toHaveLength(2);
    expect(result.execution.toolCalls.map((call) => call.name)).toContain("edit");
    expect(result.worldSnapshot).toEqual({ token, result: `${token}\n` });
    expect(result.failures).toEqual([]);
    expect(result.execution.childSessions).toHaveLength(1);
    const childId = result.execution.childSessions[0]!.threadId;
    expect(result.execution.toolCalls.find((call) => call.name === "read")?.childThreadId).toBe(childId);
    expect(result.execution.toolCalls.filter((call) => call.capability === "read" && !call.childThreadId)).toEqual([]);
    expect((result.execution.childSessions[0]!.lines[0] as { parentSession?: string }).parentSession).toBe(
      result.execution.session.threadId,
    );
  });

  test("records an ordered file read, overwrite, and confirmation read", async () => {
    const seed = "shared-seed-123";
    const original = seededToken(seed, "ORIGINAL");
    const updated = seededToken(seed, "UPDATED");
    const result = await runRuntimeEvalExecution({
      task: fileRoundtripTask,
      seed,
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: fileRoundtripStream(original, updated),
    });

    expect(result.failures).toEqual([]);
    expect(result.execution.toolCalls.map((call) => call.name)).toEqual(["read", "edit", "read"]);
    expect(result.worldSnapshot).toEqual({ original, updated, result: `${updated}\n` });
  });

  test("runs through app-server/RPC, persists evidence, and removes the exact temporary root", async () => {
    let fixtureRoot = "";
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-smoke",
      description: "smoke",
      fixtureVersion: "smoke-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        fixtureRoot = root;
        return { root, seed, expected: "done", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "reply" }],
      snapshotWorld: async () => ({ smoke: true }),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: sequenceStream([assistantMessage([{ type: "text", text: "done" }])]),
    });

    expect(result.passed).toBe(true);
    expect(result.execution.turns).toHaveLength(1);
    expect(result.execution.session.lines.length).toBeGreaterThan(2);
    expect(JSON.stringify({ ...result.execution, world: null })).not.toContain(fixtureRoot);
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("interrupts and fails a task when the runner-owned timeout expires", async () => {
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-timeout",
      description: "timeout",
      fixtureVersion: "timeout-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 0, timeoutMs: 30 },
      toolPolicy: { allowedCapabilities: [], allowedCommands: [] },
      async setup(seed, root) {
        return { root, seed, expected: "", protectedPaths: [], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "wait" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: hangingStream(),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.timeout")).toBe(true);
    expect(result.execution.termination).toBe("timeout");
  });

  test("stops before an over-budget provider turn reaches the underlying stream", async () => {
    let providerCalls = 0;
    const messages = sequenceStream([
      assistantMessage(
        [{ type: "tool_call", id: "read-1", name: "read", input: { file_path: "value.txt" } }],
        "tool_use",
      ),
    ]);
    const task: RuntimeEvalTask<RuntimeFixtureWorld> = {
      id: "runtime-turn-limit",
      description: "turn limit",
      fixtureVersion: "turn-limit-v0",
      limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 1, maxToolCalls: 2, timeoutMs: 5_000 },
      toolPolicy: { allowedCapabilities: ["read"], allowedCommands: [] },
      async setup(seed, root) {
        await writeFixture(root, { "value.txt": "value\n" });
        return { root, seed, expected: "", protectedPaths: ["value.txt"], allowedChanges: [] };
      },
      createRuntimeConfig: createFixtureRuntimeConfig,
      createSteps: () => [{ kind: "turn", message: "read" }],
      snapshotWorld: async () => ({}),
      evaluate: () => ({ passed: true }),
    };
    const result = await runRuntimeEvalExecution({
      task,
      seed: "seed",
      profile: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
      streamFunction: (...args) => {
        providerCalls += 1;
        return messages(...args);
      },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.code === "budget_exceeded.turn_limit")).toBe(true);
    expect(providerCalls).toBe(1);
  });
});

function collaborationStream(token: string): StreamFunction {
  let parentPhase = 0;
  let parentWriteIssued = false;
  return (model, context, options) => {
    const cwd = context.systemPrompt
      .map((section) => section.content)
      .join("\n")
      .match(/Current working directory: (.+)/)?.[1];
    if (!cwd) throw new Error("Could not parse runtime fixture cwd from the system prompt.");
    const results = context.messages.filter((message) => message.role === "tool_result") as Array<
      Message & { role: "tool_result"; toolName: string; output: string }
    >;
    const child = context.systemPrompt.some((section) => section.label === "nested_subagent_policy");
    let response: AssistantMessage;
    if (child) {
      const globResult = results.find((message) => message.toolName === "glob");
      const readResult = results.find((message) => message.toolName === "read");
      if (!globResult) {
        response = assistantMessage(
          [
            {
              type: "tool_call",
              id: "child-glob",
              name: "glob",
              input: { pattern: "**/delegated-value.txt", path: cwd },
            },
          ],
          "tool_use",
        );
      } else if (!readResult) {
        const absolutePath = globResult.output.match(/\/?[^\s"']*src\/delegated-value\.txt/)?.[0];
        if (!absolutePath) throw new Error(`Could not parse child glob output: ${globResult.output}`);
        response = assistantMessage(
          [{ type: "tool_call", id: "child-read", name: "read", input: { file_path: absolutePath } }],
          "tool_use",
        );
      } else response = assistantMessage([{ type: "text", text: token }]);
    } else if (context.messages.some((message) => messageText(message).includes("Using only"))) {
      if (!parentWriteIssued) {
        parentWriteIssued = true;
        response = assistantMessage(
          [
            {
              type: "tool_call",
              id: "parent-write",
              name: "edit",
              input: {
                file_path: `${cwd}/REPORT.txt`,
                old_string: "",
                new_string: `${token}\n`,
              },
            },
          ],
          "tool_use",
        );
      } else response = assistantMessage([{ type: "text", text: "Done." }]);
    } else {
      if (parentPhase === 0) {
        parentPhase += 1;
        response = assistantMessage(
          [
            {
              type: "tool_call",
              id: "parent-spawn",
              name: "spawn_agent",
              input: {
                message:
                  "CHILD_READ_CONFIG Find and read src/delegated-value.txt, then return only its exact configuration value.",
                description: "Read delegated configuration value",
                agent_type: "explore",
                model_class: "general",
                allowed_tools: ["glob", "read"],
              },
            },
          ],
          "tool_use",
        );
      } else if (parentPhase === 1) {
        parentPhase += 1;
        const spawnResult = results.find((message) => message.toolName === "spawn_agent");
        if (!spawnResult) throw new Error("Parent spawn result was missing before wait.");
        const parsed = JSON.parse(spawnResult.output) as { thread_id: string };
        response = assistantMessage(
          [
            {
              type: "tool_call",
              id: "parent-wait",
              name: "wait",
              input: { ids: [parsed.thread_id], timeout_ms: 60_000 },
            },
          ],
          "tool_use",
        );
      } else if (parentPhase === 2) {
        parentPhase += 1;
        response = assistantMessage([{ type: "text", text: "CHILD_READY" }]);
      } else response = assistantMessage([{ type: "text", text: "Done." }]);
    }
    return sequenceStream([response])(model, context, options);
  };
}

function imagePairStream(expected: string): StreamFunction {
  return (model, context, options) => {
    const prompt = messageText([...context.messages].reverse().find((message) => message.role === "user"));
    const paths = [...prompt.matchAll(/\S+\/[ab]\.png/g)].map((match) => match[0]!);
    const results = context.messages.filter((message) => message.role === "tool_result") as Array<
      Message & { role: "tool_result"; toolName: string }
    >;
    const response =
      results.length === 0
        ? assistantMessage(
            [{ type: "tool_call", id: "image-a", name: "read_image", input: { file_path: paths[0] } }],
            "tool_use",
          )
        : results.length === 1
          ? assistantMessage(
              [{ type: "tool_call", id: "image-b", name: "read_image", input: { file_path: paths[1] } }],
              "tool_use",
            )
          : assistantMessage([{ type: "text", text: expected }]);
    return sequenceStream([response])(model, context, options);
  };
}

function fileRoundtripStream(original: string, updated: string): StreamFunction {
  return (model, context, options) => {
    const prompt = messageText([...context.messages].reverse().find((message) => message.role === "user"));
    const path = prompt.match(/\S+\/document\.txt/)?.[0];
    if (!path) throw new Error("Could not parse document path from the runtime prompt.");
    const results = context.messages.filter((message) => message.role === "tool_result");
    const response =
      results.length === 0
        ? assistantMessage(
            [{ type: "tool_call", id: "roundtrip-read-1", name: "read", input: { file_path: path } }],
            "tool_use",
          )
        : results.length === 1
          ? assistantMessage(
              [
                {
                  type: "tool_call",
                  id: "roundtrip-edit",
                  name: "edit",
                  input: { file_path: path, old_string: `${original}\n`, new_string: `${updated}\n` },
                },
              ],
              "tool_use",
            )
          : results.length === 2
            ? assistantMessage(
                [{ type: "tool_call", id: "roundtrip-read-2", name: "read", input: { file_path: path } }],
                "tool_use",
              )
            : assistantMessage([{ type: "text", text: `FINAL=${updated}` }]);
    return sequenceStream([response])(model, context, options);
  };
}

function messageText(message: Message | undefined): string {
  if (!message || message.role === "tool_result") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}
