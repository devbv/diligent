#!/usr/bin/env bun
// @summary Validates commit or PR title format for repository conventions.

import { readFileSync } from "node:fs";

const ALLOWED_TYPES = ["feat", "fix", "refactor", "test", "docs", "chore"];
const TITLE_REGEX = new RegExp(`^(${ALLOWED_TYPES.join("|")})\\([a-z][a-z0-9-]*\\):\\s(.+)$`);
const MAX_SUMMARY_LENGTH = 72;

type ParsedArgs = {
  title?: string;
  file?: string;
  help: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }
    if (current === "--title") {
      parsed.title = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--file") {
      parsed.file = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
}

function readTitleFromFile(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  const firstLine = content.split(/\r?\n/u)[0] ?? "";
  return firstLine.trim();
}

function validateTitle(title: string): { valid: boolean; error?: string } {
  const trimmedTitle = title.trim();
  const match = trimmedTitle.match(TITLE_REGEX);

  if (!match) {
    return {
      valid: false,
      error:
        "Title must match '<type>(<scope>): <summary>' with allowed types feat|fix|refactor|test|docs|chore and lowercase scope.",
    };
  }

  const summary = match[2] ?? "";
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return {
      valid: false,
      error: `Summary is too long (${summary.length}). Keep it within ${MAX_SUMMARY_LENGTH} characters.`,
    };
  }

  return { valid: true };
}

function printHelp(): void {
  console.log("Validate commit/PR title format.");
  console.log("");
  console.log("Usage:");
  console.log('  bun scripts/validate-title.ts --title "fix(cli): prevent redraw flicker"');
  console.log("  bun scripts/validate-title.ts --file .git/COMMIT_EDITMSG");
}

function resolveTitleInput(args: ParsedArgs): string {
  if (args.title && args.file) {
    throw new Error("Use either --title or --file, not both.");
  }
  if (!args.title && !args.file) {
    throw new Error("Provide --title or --file.");
  }

  if (args.file) {
    return readTitleFromFile(args.file);
  }

  return args.title ?? "";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const title = resolveTitleInput(args);
  const result = validateTitle(title);

  if (!result.valid) {
    console.error("✖ Invalid title");
    console.error(`  ${result.error}`);
    console.error(`  Received: ${JSON.stringify(title)}`);
    process.exit(1);
  }

  console.log(`✔ Valid title: ${title}`);
}

main();
