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
  const modeButton = menuButtons.find((button) => button.textContent === "Mode");
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
