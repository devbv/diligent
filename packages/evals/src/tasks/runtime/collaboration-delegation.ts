// @summary Runtime eval for one bounded child-agent delegation with linked evidence

import type { RuntimeEvalTask } from "../../runtime-task";
import type { EvalProfile } from "../../task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
  writeFixture,
} from "./helpers";

export interface CollaborationDelegationWorld extends RuntimeFixtureWorld {
  token: string;
  expectedHash: string;
}

export const collaborationDelegationTask: RuntimeEvalTask<CollaborationDelegationWorld> = {
  id: "collaboration-delegation",
  description: "Delegate a protected configuration read to one child agent, wait, and persist the returned value.",
  fixtureVersion: "collaboration-delegation-v1",
  limits: {
    ...DEFAULT_RUNTIME_LIMITS,
    maxTurns: 12,
    maxToolCalls: 8,
    maxChildAgents: 1,
    timeoutMs: 360_000,
  },
  toolPolicy: {
    allowedTools: ["spawn_agent", "wait", "glob", "read", "write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["collab", "read", "write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const token = seededToken(seed, "VALUE");
    const expected = `${token}\n`;
    await writeFixture(root, { "src/delegated-value.txt": `${token}\n` });
    return {
      root,
      seed,
      token,
      expected,
      expectedHash: sha256Text(expected),
      protectedPaths: ["src/delegated-value.txt"],
      allowedChanges: ["REPORT.txt"],
    };
  },
  createRuntimeConfig: createCollaborationRuntimeConfig,
  createSteps: () => [
    {
      kind: "turn",
      message:
        "Do not inspect src/delegated-value.txt yourself. Spawn exactly one explore child agent with model_class general and allowed_tools [glob, read]. Its message must include CHILD_READ_CONFIG and instruct it to find, read, and return only the exact configuration value from src/delegated-value.txt. Wait for that child to complete. Do not create files in this turn and do not spawn any other child.",
    },
    {
      kind: "turn",
      message:
        "Using only the completed child's returned configuration value from the previous turn, create REPORT.txt containing that exact value and one trailing newline. Do not inspect src/delegated-value.txt and do not spawn another child.",
    },
  ],
  snapshotWorld: async (world) => ({ token: world.token, result: await exactFile(world.root, "REPORT.txt") }),
  evaluate(input) {
    if (input.turns.length !== 2)
      return {
        passed: false,
        code: "collaboration_delegation.turn_count",
        message: "Expected one delegation turn and one write turn.",
      };
    const successful = input.toolCalls.filter((call) => !call.error);
    const spawnIndex = successful.findIndex((call) => call.name === "spawn_agent" && !call.childThreadId);
    const waitIndex = successful.findIndex((call) => call.name === "wait" && !call.childThreadId);
    if (spawnIndex < 0 || waitIndex <= spawnIndex)
      return {
        passed: false,
        code: "collaboration_delegation.lifecycle",
        message: "Expected a parent spawn followed by a parent wait.",
      };
    const spawnInput = successful[spawnIndex]!.input;
    if (
      !isRecord(spawnInput) ||
      spawnInput.agent_type !== "explore" ||
      spawnInput.model_class !== "general" ||
      typeof spawnInput.message !== "string" ||
      !spawnInput.message.includes("CHILD_READ_CONFIG") ||
      !sameStrings(spawnInput.allowed_tools, ["glob", "read"])
    )
      return {
        passed: false,
        code: "collaboration_delegation.spawn_contract",
        message: "The child spawn did not match the bounded delegation contract.",
      };
    const parentReads = successful.filter((call) => call.capability === "read" && !call.childThreadId);
    if (parentReads.length > 0)
      return {
        passed: false,
        code: "collaboration_delegation.parent_read",
        message: "The parent inspected the protected input directly.",
      };
    const childReads = successful.filter((call) => call.name === "read" && call.childThreadId);
    if (
      childReads.length !== 1 ||
      !isRecord(childReads[0]!.input) ||
      childReads[0]!.input.file_path !== "$WORKSPACE/src/delegated-value.txt"
    )
      return {
        passed: false,
        code: "collaboration_delegation.child_read",
        message: "Exactly one child must read the protected fixture path.",
      };
    if (successful.some((call) => call.childThreadId && call.capability === "collab"))
      return {
        passed: false,
        code: "collaboration_delegation.nested_child",
        message: "The child attempted nested collaboration.",
      };
    if (input.childSessions.length !== 1)
      return {
        passed: false,
        code: "collaboration_delegation.child_session",
        message: "Expected exactly one persisted child session.",
      };
    const result = input.workspace.final.entries.find((entry) => entry.path === "REPORT.txt");
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : {
          passed: false,
          code: "collaboration_delegation.report",
          message: "REPORT.txt did not contain the exact child-returned token.",
        };
  },
};

async function createCollaborationRuntimeConfig(world: CollaborationDelegationWorld, profile: EvalProfile) {
  const config = await createFixtureRuntimeConfig(world, profile);
  return { ...config, diligent: { ...config.diligent, agents: { enabled: true } } };
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
