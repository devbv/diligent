// @summary Tests for model-aware thinking effort command options and validation

import { describe, expect, it, mock } from "bun:test";
import { resolveModel } from "@diligent/runtime";
import type { AppConfig } from "../../../../src/config";
import { effortCommand } from "../../../../src/tui/commands/builtin/effort";
import type { CommandContext } from "../../../../src/tui/commands/types";
import type { ListPickerItem } from "../../../../src/tui/components/list-picker";

function makeContext(modelId: string, overrides?: Partial<CommandContext>): CommandContext {
  return {
    app: {
      confirm: async () => true,
      pick: async () => null,
      prompt: async () => null,
      stop: () => {},
      getRpcClient: () => null,
    },
    config: { model: resolveModel(modelId) } as AppConfig,
    threadId: "thread-1",
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

describe("effortCommand", () => {
  it("accepts xhigh for GPT-5.6", async () => {
    const setEffort = mock(async () => {});
    const onEffortChanged = mock(() => {});
    const ctx = makeContext("gpt-5.6-sol", { setEffort, onEffortChanged });

    await effortCommand.handler("xhigh", ctx);

    expect(setEffort).toHaveBeenCalledWith("xhigh");
    expect(onEffortChanged).toHaveBeenCalledWith("xhigh", "xhigh");
  });

  it("rejects xhigh for GPT-5.5", async () => {
    const setEffort = mock(async () => {});
    const displayError = mock(() => {});
    const ctx = makeContext("gpt-5.5", { setEffort, displayError });

    await effortCommand.handler("xhigh", ctx);

    expect(setEffort).not.toHaveBeenCalled();
    expect(displayError).toHaveBeenCalledWith('Thinking effort "xhigh" is not supported for this model.');
  });

  it("preserves the existing command behavior for non-thinking models", async () => {
    const setEffort = mock(async () => {});
    const displayError = mock(() => {});
    const ctx = makeContext("vertex-gemma-4-26b-it", { setEffort, displayError });

    await effortCommand.handler("high", ctx);

    expect(setEffort).toHaveBeenCalledWith("high");
    expect(displayError).not.toHaveBeenCalled();
  });

  it("shows all six GPT-5.6 effort options in the picker", async () => {
    let items: ListPickerItem[] = [];
    const ctx = makeContext("gpt-5.6-terra", {
      app: {
        confirm: async () => true,
        pick: async (options) => {
          items = options.items;
          return null;
        },
        prompt: async () => null,
        stop: () => {},
        getRpcClient: () => null,
      },
    });

    await effortCommand.handler(undefined, ctx);

    expect(items.map((item) => item.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });
});
