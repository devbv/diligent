import { describe, expect, it } from "bun:test";
import { CommandRegistry } from "../registry";
import type { Command, CommandContext } from "../types";

function makeCommand(overrides: Partial<Command> & { name: string }): Command {
  return {
    description: `Test command: ${overrides.name}`,
    handler: async (_args: string | undefined, _ctx: CommandContext) => {},
    ...overrides,
  };
}

describe("CommandRegistry", () => {
  it("registers and retrieves a command by name", () => {
    const registry = new CommandRegistry();
    const cmd = makeCommand({ name: "help" });
    registry.register(cmd);

    expect(registry.get("help")).toBe(cmd);
  });

  it("retrieves a command by alias", () => {
    const registry = new CommandRegistry();
    const cmd = makeCommand({ name: "exit", aliases: ["q", "quit"] });
    registry.register(cmd);

    expect(registry.get("q")).toBe(cmd);
    expect(registry.get("quit")).toBe(cmd);
  });

  it("throws on duplicate registration", () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand({ name: "help" }));

    expect(() => {
      registry.register(makeCommand({ name: "help" }));
    }).toThrow("Duplicate command: /help");
  });

  it("lists all registered commands", () => {
    const registry = new CommandRegistry();
    const help = makeCommand({ name: "help" });
    const model = makeCommand({ name: "model" });
    registry.register(help).register(model);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContain(help);
    expect(list).toContain(model);
  });

  it("completes partial command names", () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand({ name: "help" }));
    registry.register(makeCommand({ name: "history" }));
    registry.register(makeCommand({ name: "model" }));

    expect(registry.complete("h")).toEqual(["help", "history"]);
  });

  it("returns sorted completion results", () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand({ name: "status" }));
    registry.register(makeCommand({ name: "skills" }));
    registry.register(makeCommand({ name: "stop" }));

    expect(registry.complete("s")).toEqual(["skills", "status", "stop"]);
  });

  it("includes aliases in completion", () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand({ name: "exit", aliases: ["quit"] }));

    expect(registry.complete("q")).toEqual(["quit"]);
  });

  it("returns undefined for unknown command", () => {
    const registry = new CommandRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("returns empty array for no completion matches", () => {
    const registry = new CommandRegistry();
    registry.register(makeCommand({ name: "help" }));

    expect(registry.complete("z")).toEqual([]);
  });

  describe("completeDetailed", () => {
    it("returns items with name and description", () => {
      const registry = new CommandRegistry();
      registry.register(makeCommand({ name: "help", description: "Show help" }));
      registry.register(makeCommand({ name: "model", description: "Change model" }));

      const items = registry.completeDetailed("h");
      expect(items).toEqual([{ name: "help", description: "Show help" }]);
    });

    it("excludes aliases (only primary names)", () => {
      const registry = new CommandRegistry();
      registry.register(makeCommand({ name: "exit", aliases: ["quit"], description: "Exit app" }));

      expect(registry.completeDetailed("q")).toEqual([]);
      expect(registry.completeDetailed("e")).toEqual([{ name: "exit", description: "Exit app" }]);
    });

    it("returns all commands for empty partial", () => {
      const registry = new CommandRegistry();
      registry.register(makeCommand({ name: "help" }));
      registry.register(makeCommand({ name: "model" }));

      const items = registry.completeDetailed("");
      expect(items).toHaveLength(2);
      expect(items[0].name).toBe("help");
      expect(items[1].name).toBe("model");
    });

    it("returns empty array for no matches", () => {
      const registry = new CommandRegistry();
      registry.register(makeCommand({ name: "help" }));

      expect(registry.completeDetailed("z")).toEqual([]);
    });
  });
});
