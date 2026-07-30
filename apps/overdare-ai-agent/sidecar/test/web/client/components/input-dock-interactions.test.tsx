// @summary DOM interaction tests for the composer plus-menu submenu hover behavior
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InputDock } from "../../../../src/web/client/components/InputDock";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

function renderInputDock() {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  return { rootElement, root };
}

const dockProps = {
  input: "",
  onInputChange: () => {},
  onSend: () => {},
  onSteer: () => {},
  onInterrupt: () => {},
  onCompactionClick: () => {},
  isCompacting: false,
  canSend: true,
  canSteer: false,
  threadStatus: "idle" as const,
  mode: "default" as const,
  onModeChange: () => {},
  effort: "medium" as const,
  onEffortChange: () => {},
  currentModel: "gpt-5",
  availableModels: [],
  onModelChange: () => {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
  currentContextTokens: 0,
  contextWindow: 0,
  hasProvider: true,
  supportsVision: true,
  supportsThinking: false,
  pendingImages: [],
  contextItems: [],
  isUploadingImages: false,
  onAddImages: () => {},
  onRemoveImage: () => {},
  onRemoveContextItem: () => {},
  onClearContextItems: () => {},
  slashCommands: [],
};

function hover(element: Element) {
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

test("mode submenu closes when hovering Add images", async () => {
  const { rootElement, root } = renderInputDock();

  await act(async () => {
    root.render(createElement(InputDock, dockProps));
  });

  const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Open composer options"]');
  expect(openButton).not.toBeNull();
  await act(async () => {
    openButton?.click();
  });

  const menuButtons = Array.from(document.querySelectorAll("button"));
  const modeButton = menuButtons.find((button) => button.textContent === "Mode text");
  const addImagesButton = menuButtons.find((button) => button.textContent === "Add images");
  expect(modeButton).not.toBeNull();
  expect(addImagesButton).not.toBeNull();

  await act(async () => {
    if (modeButton) hover(modeButton);
  });
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThan(0);

  await act(async () => {
    if (addImagesButton) hover(addImagesButton);
  });
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(0);

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("composer menu exposes the design-sized mode menu and selected checkmark", async () => {
  const { rootElement, root } = renderInputDock();
  let selectedMode = "";

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        onModeChange: (mode) => {
          selectedMode = mode;
        },
      }),
    );
  });

  const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Open composer options"]');
  await act(async () => {
    openButton?.click();
  });

  const mainMenu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(mainMenu?.className).toContain("w-[200px]");
  expect(mainMenu?.className).toContain("h-[80px]");

  const modeButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Mode text",
  );
  await act(async () => {
    if (modeButton) hover(modeButton);
  });

  const modeItems = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  expect(modeItems.map((item) => item.textContent)).toEqual(["Default", "Plan", "Execute"]);
  expect(modeItems[0]?.getAttribute("aria-checked")).toBe("true");
  expect(modeItems[0]?.querySelector('[data-icon="check"]')).not.toBeNull();
  expect(modeItems[1]?.querySelector('[data-icon="check"]')).toBeNull();

  const modeMenu = modeItems[0]?.closest<HTMLElement>('[role="menu"]');
  expect(modeMenu?.className).toContain("w-[180px]");
  expect(modeMenu?.className).toContain("h-[80px]");

  await act(async () => {
    modeItems[1]?.click();
  });
  expect(selectedMode).toBe("plan");

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("model menu is wide enough for long labels and keeps options on one line", async () => {
  const { rootElement, root } = renderInputDock();
  const models = [
    {
      modelId: "claude-opus-4-8",
      display: "Claude Opus 4.8",
      provider: "anthropic" as const,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      modelId: "gpt-5-6-terra",
      display: "ChatGPT 5.6 Terra",
      provider: "openai" as const,
      contextWindow: 300_000,
      maxOutputTokens: 64_000,
      supportsThinking: true,
      supportsVision: true,
    },
  ];

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        currentModel: "anthropic\0claude-opus-4-8",
        availableModels: models,
      }),
    );
  });

  const modelTrigger = rootElement.querySelector<HTMLButtonElement>('button[aria-label="Model selector"]');
  await act(async () => {
    modelTrigger?.click();
  });

  const modelMenu = rootElement.querySelector<HTMLElement>('[role="listbox"]');
  expect(modelMenu?.className).toContain("w-[180px]");

  const options = Array.from(rootElement.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  expect(options.map((option) => option.textContent)).toEqual(["Claude Opus 4.8", "ChatGPT 5.6 Terra"]);
  for (const option of options) {
    expect(option.className).toContain("whitespace-nowrap");
    expect(option.className).toContain("overflow-hidden");
    expect(option.className).toContain("text-ellipsis");
  }

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});
