#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ensureDiligentDir, listSessions } from "@diligent/core";
import { loadConfig } from "./config";
import { App } from "./tui/app";
import { NonInteractiveRunner } from "./tui/runner";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      continue: { type: "boolean", short: "c" },
      list: { type: "boolean", short: "l" },
      prompt: { type: "string", short: "p" },
    },
  });

  const cwd = process.cwd();
  const paths = await ensureDiligentDir(cwd);
  const config = await loadConfig(cwd, paths);

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

  if (values.prompt !== undefined) {
    const prompt = values.prompt.trim();
    if (!prompt) {
      console.error("Error: --prompt requires a non-empty string");
      process.exit(1);
    }
    const runner = new NonInteractiveRunner(config, paths, { resume: values.continue });
    const exitCode = await runner.run(prompt);
    process.exit(exitCode);
  }

  const app = new App(config, paths, { resume: values.continue });
  await app.start();
}

main().catch((err) => {
  console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
