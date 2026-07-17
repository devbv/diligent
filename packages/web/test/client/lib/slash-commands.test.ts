// @summary Unit tests for slash command parser, filter, prefix detection, and skill merging

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMANDS,
  buildCommandList,
  filterCommands,
  isSlashPrefix,
  parseSlashCommand,
} from "../../../src/client/lib/slash-commands";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

describe("parseSlashCommand", () => {
  test("parses command without args", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: undefined });
  });

  test("parses command with args", () => {
    expect(parseSlashCommand("/resume thread-1")).toEqual({ name: "resume", args: "thread-1" });
  });

  test("trims whitespace", () => {
    expect(parseSlashCommand("  /help  ")).toEqual({ name: "help", args: undefined });
  });

  test("trims arg whitespace", () => {
    expect(parseSlashCommand(` /model   ${TEST_ANTHROPIC_MODEL_ID}  `.trimStart())).toEqual({
      name: "model",
      args: TEST_ANTHROPIC_MODEL_ID,
    });
  });

  test("returns null for non-command text", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  test("returns null for double-slash escape", () => {
    expect(parseSlashCommand("//escaped")).toBeNull();
  });

  test("returns null for just whitespace", () => {
    expect(parseSlashCommand("   ")).toBeNull();
  });

  test("handles command with empty args after space", () => {
    expect(parseSlashCommand("/help ")).toEqual({ name: "help", args: undefined });
  });
});

describe("filterCommands", () => {
  test("empty partial returns all commands", () => {
    expect(filterCommands(BUILTIN_COMMANDS, "")).toEqual(BUILTIN_COMMANDS);
  });

  test("filters by prefix", () => {
    const result = filterCommands(BUILTIN_COMMANDS, "mo");
    expect(result.map((c) => c.name)).toEqual(["model"]);
  });

  test("exact match returns single command", () => {
    const result = filterCommands(BUILTIN_COMMANDS, "help");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("help");
  });

  test("no match returns empty array", () => {
    expect(filterCommands(BUILTIN_COMMANDS, "zzz")).toEqual([]);
  });

  test("case insensitive partial", () => {
    const result = filterCommands(BUILTIN_COMMANDS, "HE");
    expect(result.map((c) => c.name)).toEqual(["help"]);
  });

  test("filters combined commands including skills", () => {
    const commands = buildCommandList([
      { name: "backlog", description: "Manage backlog" },
      { name: "tech-lead", description: "Tech lead review" },
    ]);
    const result = filterCommands(commands, "b");
    expect(result.map((c) => c.name)).toEqual(["backlog"]);
  });
});

describe("isSlashPrefix", () => {
  test("returns true for /", () => {
    expect(isSlashPrefix("/")).toBe(true);
  });

  test("returns true for /m", () => {
    expect(isSlashPrefix("/m")).toBe(true);
  });

  test("returns true for /resume", () => {
    expect(isSlashPrefix("/resume")).toBe(true);
  });

  test("returns false for /resume thread-1 (has space)", () => {
    expect(isSlashPrefix("/resume thread-1")).toBe(false);
  });

  test("returns false for // (escape)", () => {
    expect(isSlashPrefix("//")).toBe(false);
  });

  test("returns false for regular text", () => {
    expect(isSlashPrefix("hello")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isSlashPrefix("")).toBe(false);
  });
});

describe("BUILTIN_COMMANDS", () => {
  test("has expected core commands", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toEqual(["help", "new", "resume", "model", "effort", "mcp", "reload"]);
  });

  test("resume requires args and exposes usage", () => {
    const resume = BUILTIN_COMMANDS.find((c) => c.name === "resume");
    expect(resume?.requiresArgs).toBe(true);
    expect(resume?.usage).toBe("/resume <thread-id>");
  });

  test("model requires args and exposes usage", () => {
    const model = BUILTIN_COMMANDS.find((c) => c.name === "model");
    expect(model?.requiresArgs).toBe(true);
    expect(model?.usage).toBe("/model <model-id>");
  });

  test("help has no usage metadata", () => {
    const help = BUILTIN_COMMANDS.find((c) => c.name === "help");
    expect(help?.requiresArgs).toBeUndefined();
    expect(help?.usage).toBeUndefined();
  });

  test("mcp exposes usage but does not require args (bare /mcp lists servers)", () => {
    const mcp = BUILTIN_COMMANDS.find((c) => c.name === "mcp");
    expect(mcp?.requiresArgs).toBeUndefined();
    expect(mcp?.usage).toBe("/mcp list | login <server> | logout <server>");
  });
});

describe("buildCommandList", () => {
  test("returns builtins when no skills", () => {
    const commands = buildCommandList([]);
    expect(commands).toEqual(BUILTIN_COMMANDS);
  });

  test("appends skill commands after builtins", () => {
    const commands = buildCommandList([
      { name: "backlog", description: "Manage backlog" },
      { name: "tech-lead", description: "Tech lead review" },
    ]);
    expect(commands.length).toBe(BUILTIN_COMMANDS.length + 2);
    const backlog = commands.find((c) => c.name === "backlog");
    expect(backlog).toBeDefined();
    expect(backlog?.isSkill).toBe(true);
    expect(backlog?.description).toBe("Manage backlog");
  });

  test("skips skills that collide with builtin names", () => {
    const commands = buildCommandList([
      { name: "help", description: "Collides with builtin" },
      { name: "backlog", description: "Manage backlog" },
    ]);
    // "help" skill should be skipped
    expect(commands.length).toBe(BUILTIN_COMMANDS.length + 1);
    const help = commands.find((c) => c.name === "help");
    expect(help?.isSkill).toBeUndefined();
  });

  test("skill commands have no usage metadata", () => {
    const commands = buildCommandList([{ name: "deploy", description: "Deploy app" }]);
    const deploy = commands.find((c) => c.name === "deploy");
    expect(deploy?.usage).toBeUndefined();
    expect(deploy?.requiresArgs).toBeUndefined();
  });

  test("skills can use previously web-only names now that they are not builtins", () => {
    const commands = buildCommandList([
      { name: "mode", description: "Skill named mode" },
      { name: "effort", description: "Skill named effort" },
    ]);
    expect(commands.find((c) => c.name === "mode")?.isSkill).toBe(true);
    expect(commands.find((c) => c.name === "effort")?.isSkill).toBeUndefined();
  });
});
