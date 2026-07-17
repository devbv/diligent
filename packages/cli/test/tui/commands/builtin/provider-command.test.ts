// @summary Tests for provider command parsing and execution

import { describe, expect, test } from "bun:test";
import type { Mode } from "@diligent/protocol";
import type { AppConfig } from "../../../../src/config";
import { ProviderManager } from "../../../../src/provider-manager";
import { providerCommand } from "../../../../src/tui/commands/builtin/provider";
import type { CommandRegistry } from "../../../../src/tui/commands/registry";
import type { CommandContext } from "../../../../src/tui/commands/types";
import type { ConfirmDialogOptions } from "../../../../src/tui/components/confirm-dialog";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

function createMockContext(pm: ProviderManager): {
  ctx: CommandContext;
  lines: string[];
  errors: string[];
  picks: Array<{ title: string }>;
  prompts: Array<{ title: string }>;
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const picks: Array<{ title: string }> = [];
  const prompts: Array<{ title: string }> = [];

  const ctx: CommandContext = {
    app: {
      confirm: async (_o: ConfirmDialogOptions) => true,
      pick: async (options) => {
        picks.push({ title: options.title });
        return null;
      },
      prompt: async (options) => {
        prompts.push({ title: options.title });
        return null;
      },
      stop: () => {},
    },
    config: {
      apiKey: "",
      model: {
        id: TEST_ANTHROPIC_MODEL_ID,
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
      providerManager: pm,
    },
    sessionManager: null,
    skills: [],
    registry: {} as CommandRegistry,
    requestRender: () => {},
    displayLines: (l: string[]) => lines.push(...l),
    displayError: (msg: string) => errors.push(msg),
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
  };

  return { ctx, lines, errors, picks, prompts };
}

describe("/provider command", () => {
  test("no args opens inline provider picker", async () => {
    const pm = new ProviderManager({});
    pm.setApiKey("anthropic", "sk-ant-1234567890");
    const { ctx, picks } = createMockContext(pm);

    await providerCommand.handler(undefined, ctx);

    expect(picks).toEqual([{ title: "Provider" }]);
  });

  test("status shows configured providers", async () => {
    const pm = new ProviderManager({});
    pm.setApiKey("anthropic", "sk-ant-1234567890");
    const { ctx, lines } = createMockContext(pm);

    await providerCommand.handler("status", ctx);

    const output = lines.join("\n");
    expect(output).toContain("Anthropic");
    expect(output).toContain("configured");
    expect(output).toContain("sk-ant-...");
  });

  test("status shows unconfigured providers", async () => {
    const pm = new ProviderManager({});
    const { ctx, lines } = createMockContext(pm);

    await providerCommand.handler("status", ctx);

    const output = lines.join("\n");
    expect(output).toContain("not configured");
  });

  test("set with valid provider opens inline prompt", async () => {
    const pm = new ProviderManager({});
    const { ctx, prompts } = createMockContext(pm);

    await providerCommand.handler("set openai", ctx);

    expect(prompts).toEqual([{ title: "OpenAI API Key" }]);
  });

  test("set zai-coding-plan opens inline prompt", async () => {
    const pm = new ProviderManager({});
    const { ctx, prompts } = createMockContext(pm);

    await providerCommand.handler("set zai-coding-plan", ctx);

    expect(prompts).toEqual([{ title: "z.ai Coding Plan API Key" }]);
  });

  test("set without provider opens inline provider picker", async () => {
    const pm = new ProviderManager({});
    const { ctx, picks } = createMockContext(pm);

    await providerCommand.handler("set", ctx);

    expect(picks).toEqual([{ title: "Select Provider" }]);
  });

  test("unknown subcommand shows error", async () => {
    const pm = new ProviderManager({});
    const { ctx, errors } = createMockContext(pm);

    await providerCommand.handler("foobar", ctx);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Unknown subcommand");
  });
});
