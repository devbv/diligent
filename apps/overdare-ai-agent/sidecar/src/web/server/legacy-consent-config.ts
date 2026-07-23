// @summary Removes obsolete local consent JSONC before strict runtime config validation

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@diligent/logging";
import { resolveProjectDirName } from "@diligent/runtime/infrastructure";
import { applyEdits, modify } from "jsonc-parser";

const logger = createLogger({ scope: "web.server", context: { component: "legacy-consent-config" } });
const JSONC_FORMAT_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

export async function migrateLegacyConsentConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = env.HOME ?? env.USERPROFILE ?? homedir(),
): Promise<void> {
  const projectDirName = resolveProjectDirName(env);
  const paths = [join(homeDirectory, projectDirName, "config.jsonc"), join(cwd, projectDirName, "config.jsonc")];
  await Promise.all(paths.map((path) => removeConsentAtPath(path)));
}

async function removeConsentAtPath(path: string): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    const edits = modify(content, ["consent"], undefined, { formattingOptions: JSONC_FORMAT_OPTIONS });
    if (edits.length === 0) return;
    await writeFile(path, applyEdits(content, edits));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn("migration.failed", {
      message: `[config] Failed to remove obsolete consent config from ${path}`,
      error,
      fields: { path },
    });
  }
}
