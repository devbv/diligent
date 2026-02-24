#!/usr/bin/env bun
import { loadConfig } from "./config";
import { App } from "./tui/app";

async function main() {
  try {
    const config = loadConfig();
    const app = new App(config);
    await app.start();
  } catch (err) {
    console.error(
      `\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

main();
