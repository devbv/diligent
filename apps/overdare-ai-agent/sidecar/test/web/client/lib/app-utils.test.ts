// @summary Tests for App URL and image utility helpers

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  getThreadIdFromUrl,
  normalizeImageFileName,
  replaceDraftUrl,
  replaceThreadUrl,
} from "../../../../src/web/client/lib/app-utils";

const BASE_URL = "https://example.test";
let previousWindow: typeof globalThis.window | undefined;

function installMockWindow(pathname: string) {
  const state = { pathname };
  const mockWindow = {
    location: {
      get pathname() {
        return state.pathname;
      },
      set pathname(next: string) {
        state.pathname = next;
      },
    },
    history: {
      replaceState: (_data: unknown, _title: string, url: string) => {
        const parsed = new URL(url, BASE_URL);
        state.pathname = parsed.pathname;
      },
    },
  } as unknown as Window;
  (globalThis as { window?: Window }).window = mockWindow;
}

beforeEach(() => {
  previousWindow = globalThis.window;
  installMockWindow("/");
});

afterEach(() => {
  if (previousWindow) {
    (globalThis as { window?: Window }).window = previousWindow;
    return;
  }
  delete (globalThis as { window?: Window }).window;
});

test("getThreadIdFromUrl returns null at root path", () => {
  window.history.replaceState(null, "", `${BASE_URL}/`);
  expect(getThreadIdFromUrl()).toBeNull();
});

test("getThreadIdFromUrl strips leading slash", () => {
  window.history.replaceState(null, "", `${BASE_URL}/thread-123`);
  expect(getThreadIdFromUrl()).toBe("thread-123");
});

test("replaceThreadUrl updates path only when target differs", () => {
  window.history.replaceState(null, "", `${BASE_URL}/old`);
  replaceThreadUrl("new-thread");
  expect(window.location.pathname).toBe("/new-thread");

  replaceThreadUrl("new-thread");
  expect(window.location.pathname).toBe("/new-thread");
});

test("replaceDraftUrl returns app to root path", () => {
  window.history.replaceState(null, "", `${BASE_URL}/thread-123`);
  replaceDraftUrl();
  expect(window.location.pathname).toBe("/");
});

test("normalizeImageFileName returns .bin fallback for unknown mime type", () => {
  const file = new File(["x"], "", { type: "application/octet-stream" });
  expect(normalizeImageFileName(file, 3, 99)).toBe("pasted-image-99-3.bin");
});
