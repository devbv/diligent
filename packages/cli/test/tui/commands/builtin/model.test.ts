// @summary Tests for model command picker filtering behavior based on provider authentication

import { describe, expect, it, mock } from "bun:test";
import { resolveModel } from "@diligent/runtime";
import type { AppConfig } from "../../../../src/config";
import { modelCommand } from "../../../../src/tui/commands/builtin/model";
import type { CommandContext } from "../../../../src/tui/commands/types";
import type { ListPickerItem } from "../../../../src/tui/components/list-picker";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-5";

function makeConfig(modelId: string, providerManager: AppConfig["providerManager"]): AppConfig {
  const ref =
    modelId === "gpt-4o"
      ? { provider: "openai" as const, modelId: "gpt-5.6-sol" }
      : modelId.startsWith("gpt-")
        ? { provider: "openai" as const, modelId }
        : { provider: "anthropic" as const, modelId };
  return {
    apiKey: "",
    model: resolveModel(ref),
    systemPrompt: [],
    streamFunction: (() => {
      throw new Error("not used");
    }) as AppConfig["streamFunction"],
    diligent: {},
    sources: [],
    skills: [],
    mode: "default",
    compaction: {
      enabled: true,
      reservePercent: 10,
      keepRecentTokens: 4000,
    },
    providerManager,
  } as AppConfig;
}

function makeContext(config: AppConfig, overrides?: Partial<CommandContext>): CommandContext {
  return {
    app: {
      confirm: async () => true,
      pick: async () => null,
      prompt: async () => null,
      stop: () => {},
      getRpcClient: () => null,
    },
    config,
    threadId: null,
    skills: [],
    registry: {} as CommandContext["registry"],
    requestRender: () => {},
    displayLines: () => {},
    displayError: () => {},
    runAgent: async () => {},
    reload: async () => {},
    currentMode: "default",
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
  } as CommandContext;
}

describe("modelCommand picker", () => {
  it("shows only models for authenticated providers", async () => {
    let capturedItems: ListPickerItem[] = [];

    const providerManager = {
      hasKeyFor: mock((provider: string) => provider === "openai"),
    };

    const config = makeConfig("gpt-4o", providerManager as unknown as AppConfig["providerManager"]);

    const ctx = makeContext(config, {
      app: {
        confirm: async () => true,
        pick: async (options) => {
          capturedItems = options.items;
          return null;
        },
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => null,
      },
    });

    await modelCommand.handler(undefined, ctx);

    expect(capturedItems.length).toBeGreaterThan(0);
    const modelItems = capturedItems.filter((item) => !item.header);
    expect(modelItems.filter((item) => item.value).every((item) => item.value.startsWith("openai/"))).toBe(true);
    expect(capturedItems.some((item) => item.header && item.label.includes("OpenAI"))).toBe(true);
    expect(capturedItems.some((item) => item.header && item.label.includes("Anthropic"))).toBe(false);
  });

  it("falls back to current provider models when no provider is authenticated", async () => {
    let capturedItems: ListPickerItem[] = [];

    const providerManager = {
      hasKeyFor: mock((_provider: string) => false),
    };

    const config = makeConfig(TEST_ANTHROPIC_MODEL_ID, providerManager as unknown as AppConfig["providerManager"]);

    const ctx = makeContext(config, {
      app: {
        confirm: async () => true,
        pick: async (options) => {
          capturedItems = options.items;
          return null;
        },
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => null,
      },
    });

    await modelCommand.handler(undefined, ctx);

    expect(capturedItems.length).toBeGreaterThan(0);
    const modelItems = capturedItems.filter((item) => !item.header);
    expect(modelItems.length).toBeGreaterThan(0);
    expect(modelItems.filter((item) => item.value).every((item) => item.value.startsWith("anthropic/"))).toBe(true);
    expect(capturedItems.some((item) => item.header && item.label.includes("Anthropic"))).toBe(true);
    expect(capturedItems.some((item) => item.header && item.label.includes("OpenAI"))).toBe(false);
  });

  it("routes explicit model changes through the thread-aware setter", async () => {
    const providerManager = {
      hasKeyFor: mock((_provider: string) => true),
    };
    const setModel = mock(async (_modelId: string) => {});
    const onModelChanged = mock((_modelId: string) => {});

    const config = makeConfig(TEST_ANTHROPIC_MODEL_ID, providerManager as unknown as AppConfig["providerManager"]);
    const ctx = makeContext(config, {
      threadId: "thread-child",
      setModel,
      onModelChanged,
    });

    await modelCommand.handler("claude-haiku-4-5", ctx);

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalled();
    expect(onModelChanged).toHaveBeenCalled();
    expect(config.model.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("preserves xhigh when switching between OpenAI models", async () => {
    const providerManager = {
      hasKeyFor: mock((_provider: string) => true),
    };
    const setEffort = mock(async () => {});
    const onEffortChanged = mock(() => {});
    const config = makeConfig("gpt-5.6-sol", providerManager as unknown as AppConfig["providerManager"]);
    const ctx = makeContext(config, {
      currentEffort: "xhigh",
      setEffort,
      onEffortChanged,
    });

    await modelCommand.handler("gpt-5.5", ctx);

    expect(setEffort).not.toHaveBeenCalled();
    expect(onEffortChanged).not.toHaveBeenCalled();
  });
});
