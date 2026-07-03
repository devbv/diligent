// @summary Tests for the TUI auto progress mode command

import { describe, expect, it, mock } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS, type Mode } from "@diligent/protocol";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "@diligent/runtime";
import type { AppConfig } from "../../../../src/config";
import { registerBuiltinCommands } from "../../../../src/tui/commands/builtin";
import { autoProgressCommand } from "../../../../src/tui/commands/builtin/auto-progress";
import { CommandRegistry } from "../../../../src/tui/commands/registry";
import type { CommandContext } from "../../../../src/tui/commands/types";
import type { AppServerRpcClient } from "../../../../src/tui/rpc-client";

function makeContext(overrides?: Partial<CommandContext>): {
  ctx: CommandContext;
  errors: string[];
  lines: string[];
  requests: Array<{ method: string; params: unknown }>;
  requestRender: ReturnType<typeof mock>;
} {
  const errors: string[] = [];
  const lines: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const requestRender = mock(() => {});
  const rpc = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return { autoProgressMode: (params as { autoProgressMode: boolean }).autoProgressMode };
    },
    notify: async () => {},
    setNotificationListener: () => {},
    setServerRequestHandler: () => {},
    dispose: async () => {},
  } as unknown as AppServerRpcClient;

  const ctx: CommandContext = {
    app: {
      confirm: async () => true,
      pick: async () => null,
      prompt: async () => null,
      stop: () => {},
      getRpcClient: () => rpc,
    },
    config: {
      apiKey: "",
      model: {
        id: DEFAULT_ANTHROPIC_MODEL_ID,
        provider: "anthropic",
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      },
      systemPrompt: [],
      streamFunction: (() => {}) as unknown as AppConfig["streamFunction"],
      diligent: {},
      sources: [],
      skills: [],
      mode: "default" as Mode,
      providerManager: {} as AppConfig["providerManager"],
    },
    threadId: null,
    skills: [],
    registry: new CommandRegistry(),
    requestRender,
    displayLines: (next) => lines.push(...next),
    displayError: (message) => errors.push(message),
    runAgent: async () => {},
    reload: async () => {},
    currentMode: "default" as Mode,
    setMode: () => {},
    currentEffort: "medium",
    setEffort: async () => {},
    setModel: async () => {},
    clearChatHistory: () => {},
    clearScreenAndResetRenderer: () => {},
    startNewThread: async () => "thread-1",
    resumeThread: async () => "thread-1",
    deleteThread: async () => true,
    listThreads: async () => [],
    readThread: async () => null,
    onModelChanged: () => {},
    onEffortChanged: () => {},
    ...overrides,
  };

  return { ctx, errors, lines, requests, requestRender };
}

describe("/auto-progress command", () => {
  it("enables auto progress mode via config/set", async () => {
    const { ctx, lines, requests, requestRender } = makeContext();

    await autoProgressCommand.handler("on", ctx);

    expect(requests).toEqual([
      { method: DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, params: { autoProgressMode: true } },
    ]);
    expect(lines.join("\n")).toContain("enabled");
    expect(lines.join("\n")).toContain("Run /reload or open a new session to apply this change.");
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("disables auto progress mode via config/set", async () => {
    const { ctx, lines, requests } = makeContext();

    await autoProgressCommand.handler("off", ctx);

    expect(requests).toEqual([
      { method: DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, params: { autoProgressMode: false } },
    ]);
    expect(lines.join("\n")).toContain("disabled");
  });

  it("shows usage when the argument is missing or unknown", async () => {
    const { ctx, errors, requests } = makeContext();

    await autoProgressCommand.handler("sometimes", ctx);

    expect(errors).toEqual(["Usage: /auto-progress <on|off>"]);
    expect(requests).toEqual([]);
  });

  it("registers /auto-progress as a built-in command", () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry, []);

    const command = registry.get("auto-progress");
    expect(command?.name).toBe("auto-progress");
    expect(command?.description).toContain("auto progress");
  });
});
