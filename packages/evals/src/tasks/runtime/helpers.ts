// @summary Shared fixture and explicit RuntimeConfig helpers for runtime eval tasks

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveModel } from "@diligent/core/model-registry";
import { ProviderManager } from "@diligent/core/provider-contract";
import {
  buildBaseSystemPrompt,
  buildSystemPrompt,
  createYoloPermissionEngine,
  discoverInstructions,
  discoverSkills,
  getBuiltinAgentDefinitions,
  type RuntimeConfig,
  renderSkillsSection,
  type SkillMetadata,
} from "@diligent/runtime";
import type { RuntimeVerifierResult } from "../../runtime-task";
import type { EvalProfile } from "../../task";

export interface RuntimeFixtureWorld {
  root: string;
  seed: string;
  expected: string;
  protectedPaths: string[];
  allowedChanges: string[];
}

export async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
}

export async function createFixtureRuntimeConfig(
  world: RuntimeFixtureWorld,
  profile: EvalProfile,
): Promise<RuntimeConfig> {
  const model = resolveModel({ provider: profile.provider, modelId: profile.model });
  const providerManager = new ProviderManager({});
  const discovered = await discoverSkills({ cwd: world.root });
  const skills: SkillMetadata[] = discovered.skills;
  const instructions = await discoverInstructions(world.root);
  const basePrompt = buildBaseSystemPrompt({
    currentDate: "2026-07-18",
    cwd: world.root,
    platform: process.platform,
  });
  const systemPrompt = buildSystemPrompt(basePrompt, instructions, [renderSkillsSection(skills)].filter(Boolean));
  const agentDefinitions = getBuiltinAgentDefinitions();
  return {
    model,
    effort: profile.effort,
    mode: "default",
    planReminderIntervalTurns: 0,
    systemPrompt,
    streamFunction: () => {
      throw new Error("Runtime eval runner did not install the profile stream.");
    },
    diligent: { knowledge: { enabled: false }, agents: { enabled: false } },
    sources: [],
    configLayers: {},
    discoveredSkills: skills,
    skills,
    discoveredAgents: [],
    agents: [],
    agentCatalog: agentDefinitions.map((definition) => ({
      definition,
      source: "builtin",
      required: definition.name === "general",
    })),
    agentDefinitions,
    compaction: { enabled: false, reservePercent: 16, keepRecentTokens: 20_000, timeoutMs: 180_000 },
    permissionEngine: createYoloPermissionEngine(),
    providerManager,
    authStore: { mode: "ephemeral" },
    experimentDefinitions: [],
    experiments: [],
    disabledToolNames: new Set(),
    disabledSkillNames: new Set(),
    disabledAgentNames: new Set(),
  };
}

export async function runVerifier(
  world: RuntimeFixtureWorld,
  argv: string[],
  signal: AbortSignal,
): Promise<RuntimeVerifierResult> {
  const started = performance.now();
  const process = Bun.spawn(argv, { cwd: world.root, stdout: "pipe", stderr: "pipe", signal });
  const exitCode = await process.exited;
  return {
    argv,
    exitCode,
    elapsedMs: Math.round(performance.now() - started),
    stdout: (await new Response(process.stdout).text()).slice(0, 16_384),
    stderr: (await new Response(process.stderr).text()).slice(0, 16_384),
    timedOut: signal.aborted,
  };
}

export async function exactFile(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

export function seededToken(seed: string, prefix: string): string {
  return `${prefix}_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "seed"}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const DEFAULT_RUNTIME_LIMITS = {
  maxChangedFiles: 3,
  maxChangedBytes: 65_536,
  maxUserInputRequests: 0,
  maxChildAgents: 0,
  verifierTimeoutMs: 60_000,
  maxOutputTokens: 8_192,
} as const;
