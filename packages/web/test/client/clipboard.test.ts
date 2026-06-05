// @summary Clipboard copy works in secure context and falls back in non-secure (HTTP) contexts
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, expect, test } from "bun:test";
import { copyTextToClipboard } from "../../src/client/lib/clipboard";

afterAll(() => {
  // Avoid leaking happy-dom globals (window/navigator/localStorage) into other
  // test files that run later in the same process.
  void GlobalRegistrator.unregister();
});

function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}

afterEach(() => {
  // Reset overrides between tests.
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

test("uses navigator.clipboard in a secure context", async () => {
  let written: string | null = null;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (t: string) => {
        written = t;
      },
    },
    configurable: true,
  });
  setSecureContext(true);

  const ok = await copyTextToClipboard("hello secure");
  expect(ok).toBe(true);
  expect(written).toBe("hello secure");
});

test("falls back to execCommand when navigator.clipboard is unavailable (non-secure HTTP)", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  setSecureContext(false);

  let execArg: string | null = null;
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (cmd: string) => {
    execArg = cmd;
    return true;
  };

  const ok = await copyTextToClipboard("hello http");
  expect(ok).toBe(true);
  expect(execArg).toBe("copy");
});

test("falls back to execCommand when writeText throws", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("blocked");
      },
    },
    configurable: true,
  });
  setSecureContext(true);

  let execCalled = false;
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = () => {
    execCalled = true;
    return true;
  };

  const ok = await copyTextToClipboard("retry");
  expect(ok).toBe(true);
  expect(execCalled).toBe(true);
});
