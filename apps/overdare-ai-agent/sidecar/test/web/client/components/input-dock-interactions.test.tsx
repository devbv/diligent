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

const MODELS = [
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

function findModelMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"][aria-label="Models"]');
}

function findEffortMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"][aria-label="Effort"]');
}

test("model pill shows the effort suffix and opens a design-sized Models menu", async () => {
  const { rootElement, root } = renderInputDock();
  let selectedModel = "";

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        currentModel: "openai\0gpt-5-6-terra",
        availableModels: MODELS,
        supportsThinking: true,
        effort: "high" as const,
        onModelChange: (modelId: string) => {
          selectedModel = modelId;
        },
      }),
    );
  });

  const modelTrigger = rootElement.querySelector<HTMLButtonElement>('button[aria-label="Model selector"]');
  expect(modelTrigger?.textContent).toContain("ChatGPT 5.6 Terra");
  expect(modelTrigger?.textContent).toContain("High");

  await act(async () => {
    modelTrigger?.click();
  });

  expect(findModelMenu()?.className).toContain("w-[200px]");
  expect(findModelMenu()?.textContent).toContain("Models");

  const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  expect(options.map((option) => option.textContent?.trim())).toEqual(["Claude Opus 4.8", "ChatGPT 5.6 Terra"]);
  for (const option of options) {
    expect(option.className).toContain("whitespace-nowrap");
    expect(option.className).toContain("overflow-hidden");
    expect(option.className).toContain("text-ellipsis");
  }
  expect(options[1]?.getAttribute("aria-checked")).toBe("true");
  expect(options[1]?.querySelector('[data-icon="check"]')).not.toBeNull();

  await act(async () => {
    options[0]?.click();
  });
  expect(selectedModel).toBe("anthropic\0claude-opus-4-8");
  expect(findModelMenu()).toBeNull();

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

function findEffortRow(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (button) => button.textContent?.trim() === "Effort",
  );
}

test("the Effort row under the model list opens the headerless effort submenu", async () => {
  const { rootElement, root } = renderInputDock();
  let selectedEffort = "";

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        currentModel: "openai\0gpt-5-6-terra",
        availableModels: MODELS,
        supportsThinking: true,
        onEffortChange: (effort: string) => {
          selectedEffort = effort;
        },
      }),
    );
  });

  await act(async () => {
    rootElement.querySelector<HTMLButtonElement>('button[aria-label="Model selector"]')?.click();
  });

  // Model rows no longer carry a submenu affordance — Effort is a single row beneath them.
  for (const option of document.querySelectorAll('[role="menuitemradio"]')) {
    expect(option.getAttribute("aria-haspopup")).toBeNull();
  }
  const effortRow = findEffortRow();
  expect(effortRow).toBeDefined();
  expect(effortRow?.getAttribute("aria-haspopup")).toBe("menu");
  expect(findEffortMenu()).toBeNull();

  await act(async () => {
    if (effortRow) hover(effortRow);
  });

  const effortMenu = findEffortMenu();
  expect(effortMenu?.className).toContain("w-[180px]");
  // The submenu carries no header of its own; the rows start immediately.
  expect(effortMenu?.textContent?.trim().startsWith("Low")).toBe(true);

  const effortItems = Array.from(effortMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
  expect(effortItems.map((item) => item.textContent?.trim())).toEqual(["Low", "Medium", "High", "Extra High", "Max"]);

  await act(async () => {
    effortItems[3]?.click();
  });
  expect(selectedEffort).toBe("xhigh");
  expect(findModelMenu()).toBeNull();

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("the Effort row is disabled for a model without thinking efforts", async () => {
  const { rootElement, root } = renderInputDock();

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        currentModel: "anthropic\0claude-opus-4-8",
        availableModels: MODELS,
        supportsThinking: true,
      }),
    );
  });

  await act(async () => {
    rootElement.querySelector<HTMLButtonElement>('button[aria-label="Model selector"]')?.click();
  });

  const effortRow = findEffortRow();
  expect(effortRow?.disabled).toBe(true);

  await act(async () => {
    if (effortRow) hover(effortRow);
  });
  expect(findEffortMenu()).toBeNull();

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("busy composer swaps the send arrow for queue and stop controls", async () => {
  const { rootElement, root } = renderInputDock();
  let interrupted = false;

  await act(async () => {
    root.render(
      createElement(InputDock, {
        ...dockProps,
        threadStatus: "busy" as const,
        canSteer: true,
        onInterrupt: () => {
          interrupted = true;
        },
      }),
    );
  });

  expect(rootElement.querySelector('button[aria-label="Send message"]')).toBeNull();
  expect(rootElement.querySelector('button[aria-label="Queue message"]')).not.toBeNull();

  const stopButton = rootElement.querySelector<HTMLButtonElement>('button[aria-label="Interrupt turn"]');
  expect(stopButton?.querySelector('[data-icon="stop"]')).not.toBeNull();
  await act(async () => {
    stopButton?.click();
  });
  expect(interrupted).toBe(true);

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});
