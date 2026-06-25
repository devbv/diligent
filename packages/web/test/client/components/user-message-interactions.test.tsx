// @summary DOM interaction tests for user message image attachment fallbacks
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { UserMessage } from "../../../src/client/components/UserMessage";

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
