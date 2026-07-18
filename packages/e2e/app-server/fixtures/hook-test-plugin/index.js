// @summary Plugin fixture for app-server prompt and stop hook e2e scenarios
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const manifest = {
  name: "hook-test-plugin",
  apiVersion: "1.0",
  version: "0.1.0",
};

export async function createTools() {
  return [];
}

/**
 * UserPromptSubmit hook: blocks the prompt if it starts with "BLOCK".
 * Otherwise injects a short additionalContext marker for observability.
 */
export async function onUserPromptSubmit(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (prompt.startsWith("BLOCK")) {
    return { blocked: true, reason: "Blocked by hook-test-plugin" };
  }
  return { blocked: false, additionalContext: "hook-test-plugin:UserPromptSubmit" };
}

/**
 * Stop hook: writes a marker file to the cwd so the test can verify it fired.
 */
export async function onStop(input) {
  const markerPath = join(input.cwd, "hook-stop-fired");
  await writeFile(markerPath, JSON.stringify({ hook_event_name: input.hook_event_name }));
  return { blocked: false };
}
