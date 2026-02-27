import { version as pkgVersion } from "../../../../package.json";
import { t } from "../../theme";
import type { Command } from "../types";

export const clearCommand: Command = {
  name: "clear",
  description: "Clear chat display",
  availableDuringTask: true,
  aliases: ["cls"],
  handler: async (_args, ctx) => {
    // ChatView clear is handled by the app integration
    ctx.displayLines(["\x1b[2J\x1b[H"]); // ANSI clear screen
  },
};

export const exitCommand: Command = {
  name: "exit",
  description: "Exit diligent",
  availableDuringTask: true,
  aliases: ["quit", "q"],
  handler: async (_args, ctx) => {
    ctx.app.stop();
  },
};

export const versionCommand: Command = {
  name: "version",
  description: "Show version",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    ctx.displayLines([`  diligent v${pkgVersion}`]);
  },
};

export const configCommand: Command = {
  name: "config",
  description: "Show config sources",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    const lines = [""];
    if (ctx.config.sources.length === 0) {
      lines.push(`  ${t.dim}No config files loaded (using defaults).${t.reset}`);
    } else {
      lines.push(`  ${t.bold}Config sources:${t.reset}`);
      for (const source of ctx.config.sources) {
        lines.push(`    ${t.dim}${source}${t.reset}`);
      }
    }
    lines.push("");
    ctx.displayLines(lines);
  },
};

export const costCommand: Command = {
  name: "cost",
  description: "Show token usage estimate",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    ctx.displayLines([`  ${t.dim}Token cost tracking coming soon.${t.reset}`]);
  },
};

export const bugCommand: Command = {
  name: "bug",
  description: "Report a bug or give feedback",
  availableDuringTask: true,
  handler: async (_args, ctx) => {
    ctx.displayLines([
      "",
      `  ${t.bold}Feedback & Bug Reports:${t.reset}`,
      "  https://github.com/anthropics/diligent/issues",
      "",
    ]);
  },
};
