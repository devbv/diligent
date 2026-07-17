// @summary Generates and derives reproducible synthetic-world seeds

import { createHash, createHmac, randomBytes } from "node:crypto";

export function createRandomRootSeed(): string {
  return randomBytes(32).toString("hex");
}

export function createGithubRootSeed(repository: string, runId: string, commitSha: string): string {
  return createHash("sha256").update(`${repository}:${runId}:${commitSha}`).digest("hex");
}

export function deriveTaskSeed(rootSeed: string, taskId: string): string {
  return createHmac("sha256", rootSeed).update(taskId).digest("hex");
}

export function deriveFixtureValue(seed: string, label: string, length = 20): string {
  return createHmac("sha256", seed).update(label).digest("hex").slice(0, length);
}
