// @summary Plugin fixture for app-server stop-hook re-entry e2e scenarios
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const manifest = {
  name: "rerun-hook-plugin",
  apiVersion: "1.0",
  version: "0.1.0",
};

export async function createTools() {
  return [];
}

/**
 * Stop hook: on the first call (stop_hook_active=false) blocks with a follow-up message.
 * On the re-run (stop_hook_active=true) allows completion and writes a marker file.
 * This exercises the stop_hook_active re-entrance guard to ensure no infinite loop.
 */
export async function onStop(input) {
  const markerPath = join(input.cwd, "rerun-hook-calls");
  let calls = [];
  try {
    const { readFile } = await import("node:fs/promises");
    calls = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    // first call
  }
  calls.push({ stop_hook_active: input.stop_hook_active });
  await writeFile(markerPath, JSON.stringify(calls));

  if (!input.stop_hook_active) {
    return { blocked: true, reason: "Stop hook blocked: please note this and complete." };
  }
  return { blocked: false };
}
