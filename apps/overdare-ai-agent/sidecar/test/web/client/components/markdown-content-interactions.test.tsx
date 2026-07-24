// @summary DOM interaction tests for Markdown code-block copy feedback
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownContent } from "../../../../src/web/client/components/MarkdownContent";

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  void GlobalRegistrator.unregister();
});

test("code-block copy button copies raw code and shows a check state for one second", async () => {
  let copiedText = "";
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        copiedText = text;
      },
    },
    configurable: true,
  });

  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);

  await act(async () => {
    root.render(createElement(MarkdownContent, { text: "```ts\nconst value = 1;\n```" }));
  });

  const copyButton = rootElement.querySelector<HTMLButtonElement>("[data-code-copy-button]");
  expect(copyButton).not.toBeNull();
  expect(copyButton?.dataset.copied).toBe("false");
  expect(copyButton?.getAttribute("aria-label")).toBe("Copy ts code");

  await act(async () => {
    copyButton?.click();
  });

  expect(copiedText).toBe("const value = 1;");
  expect(copyButton?.dataset.copied).toBe("true");
  expect(copyButton?.getAttribute("aria-label")).toBe("Copied");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_050));
  });

  expect(copyButton?.dataset.copied).toBe("false");
  expect(copyButton?.getAttribute("aria-label")).toBe("Copy ts code");

  await act(async () => {
    root.unmount();
  });
  rootElement.remove();
});
