// @summary DOM interaction tests for image attachment fallbacks
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InputDock } from "../../../../src/web/client/components/InputDock";
import { UserMessage } from "../../../../src/web/client/components/UserMessage";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

test("user image attachment falls back to a file chip when the image cannot load", async () => {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(UserMessage, {
        text: "see attached",
        images: [{ url: "/missing/floor.png", fileName: "floor.png", mediaType: "image/png" }],
      }),
    );
  });

  const image = rootElement.querySelector<HTMLImageElement>("img");
  if (image) {
    await act(async () => {
      image.dispatchEvent(new Event("error", { bubbles: true }));
    });
  }

  expect(rootElement.querySelector("img")).toBeNull();
  expect(rootElement.textContent).toContain("floor.png");
  expect(rootElement.textContent).toContain("Image unavailable");

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});

test("composer image preview falls back when the image cannot load", async () => {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(
      createElement(InputDock, {
        input: "",
        onInputChange: () => {},
        onSend: () => {},
        onSteer: () => {},
        onInterrupt: () => {},
        onCompactionClick: () => {},
        isCompacting: false,
        canSend: true,
        canSteer: false,
        threadStatus: "idle",
        mode: "default",
        onModeChange: () => {},
        effort: "medium",
        onEffortChange: () => {},
        currentModel: "gpt-5",
        availableModels: [],
        onModelChange: () => {},
        currentContextTokens: 0,
        contextWindow: 0,
        hasProvider: true,
        supportsVision: true,
        supportsThinking: true,
        pendingImages: [{ path: "/tmp/shot.png", url: "/missing/shot.png", fileName: "shot.png" }],
        contextItems: [],
        isUploadingImages: false,
        onAddImages: () => {},
        onRemoveImage: () => {},
        onRemoveContextItem: () => {},
        onClearContextItems: () => {},
      }),
    );
  });

  const image = rootElement.querySelector<HTMLImageElement>("img");
  if (image) {
    await act(async () => {
      image.dispatchEvent(new Event("error", { bubbles: true }));
    });
  }

  expect(rootElement.querySelector("img")).toBeNull();
  expect(rootElement.textContent).toContain("IMG");
  expect(rootElement.textContent).toContain("shot.png");
  expect(rootElement.querySelector('button[aria-label="Remove shot.png"]')).not.toBeNull();

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});
