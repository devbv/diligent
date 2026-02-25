#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ensureDiligentDir, listSessions } from "@diligent/core";
import { loadConfig } from "./config";
import { App } from "./tui/app";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      continue: { type: "boolean", short: "c" },
      list: { type: "boolean", short: "l" },
    },
  });

  const cwd = process.cwd();
  const paths = await ensureDiligentDir(cwd);
  const config = await loadConfig(cwd);

  if (values.list) {
    const sessions = await listSessions(paths.sessions);
    if (sessions.length === 0) {
      console.log("No sessions found.");
    } else {
      for (const [i, s] of sessions.entries()) {
        const date = s.modified.toISOString().slice(0, 16).replace("T", " ");
        const preview = s.firstUserMessage ?? "(no messages)";
        console.log(`  ${i + 1}. [${date}] ${preview} (${s.messageCount} messages)`);
      }
    }
    return;
  }

  const app = new App(config, paths, { resume: values.continue });
  await app.start();
}

main().catch((err) => {
  console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
