// @summary Runtime eval fixture for persisted multi-turn session restart and resume

import type { RuntimeEvalTask } from "../../runtime-task";
import {
  createFixtureRuntimeConfig,
  DEFAULT_RUNTIME_LIMITS,
  exactFile,
  type RuntimeFixtureWorld,
  seededToken,
  sha256Text,
} from "./helpers";

interface ResumeWorld extends RuntimeFixtureWorld {
  codename: string;
  expectedHash: string;
}
export const sessionResumeTask: RuntimeEvalTask<ResumeWorld> = {
  id: "session-resume",
  description: "Resume a persisted session and use earlier context in a file mutation.",
  fixtureVersion: "session-resume-v0",
  limits: { ...DEFAULT_RUNTIME_LIMITS, maxTurns: 10, maxToolCalls: 8, timeoutMs: 300_000 },
  toolPolicy: {
    allowedTools: ["write", "edit", "multi_edit", "apply_patch"],
    allowedCapabilities: ["write"],
    allowedCommands: [],
  },
  async setup(seed, root) {
    const codename = seededToken(seed, "CODENAME");
    return {
      root,
      seed,
      codename,
      expected: `${codename}\n`,
      expectedHash: sha256Text(`${codename}\n`),
      protectedPaths: [],
      allowedChanges: ["CODENAME.txt"],
    };
  },
  createRuntimeConfig: createFixtureRuntimeConfig,
  createSteps: (world) => [
    { kind: "turn", message: `Remember project codename ${world.codename}. Reply only ACK.` },
    { kind: "restart_and_resume" },
    {
      kind: "turn",
      message:
        "Create CODENAME.txt containing the earlier codename and one trailing newline. Do not repeat it in your response.",
    },
  ],
  snapshotWorld: async (world) => ({ codename: world.codename, result: await exactFile(world.root, "CODENAME.txt") }),
  evaluate(input) {
    if (input.turns.length !== 2)
      return { passed: false, code: "session_resume.turn_count", message: "Expected two completed turns." };
    if (input.session.lines.length < 3)
      return { passed: false, code: "session_resume.persistence", message: "Persisted session is incomplete." };
    const result = input.workspace.final.entries.find((entry) => entry.path === "CODENAME.txt");
    return result?.sha256 === input.world.expectedHash
      ? { passed: true }
      : {
          passed: false,
          code: "session_resume.wrong_codename",
          message: "CODENAME.txt does not contain the exact earlier codename.",
        };
  },
};
