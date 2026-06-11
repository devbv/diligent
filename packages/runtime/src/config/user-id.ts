// @summary Resolves the effective userId using explicit config or a persisted global UUID fallback

import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProjectDirName } from "../infrastructure/diligent-dir";

const USER_ID_FILE_NAME = "user-id";

function getGlobalDiligentDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, resolveProjectDirName());
}

export function getGlobalUserIdPath(): string {
  return join(getGlobalDiligentDir(), USER_ID_FILE_NAME);
}

export async function resolveConfiguredUserId(configuredUserId?: string): Promise<string> {
  if (configuredUserId?.trim()) {
    return configuredUserId.trim();
  }

  const userIdPath = getGlobalUserIdPath();
  const existing = await readFile(userIdPath, "utf-8").catch(() => "");
  const normalized = existing.trim();
  if (normalized) {
    return normalized;
  }

  const generated = crypto.randomUUID();
  await mkdir(dirname(userIdPath), { recursive: true });
  await Bun.write(userIdPath, `${generated}\n`);
  return generated;
}
