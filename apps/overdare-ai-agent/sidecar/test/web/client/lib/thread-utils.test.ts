// @summary Tests for shared thread render-state helpers

import { expect, test } from "bun:test";
import type { RenderItem } from "../../../../src/web/client/lib/thread-store";
import { hasPendingUserInputTool } from "../../../../src/web/client/lib/thread-utils";

function toolItem(overrides: Partial<Extract<RenderItem, { kind: "tool" }>>): Extract<RenderItem, { kind: "tool" }> {
  return {
    id: "tool-1",
    kind: "tool",
    toolName: "request_user_input",
    inputText: "",
    outputText: "",
    isError: false,
    status: "streaming",
    timestamp: 1,
    toolCallId: "call-1",
    startedAt: 1,
    ...overrides,
  };
}

test("detects streaming request_user_input tools as blocking prompt UI", () => {
  expect(hasPendingUserInputTool([toolItem({ toolName: "overdare/request_user_input" })])).toBe(true);
});

test("ignores completed request_user_input tools and unrelated streaming tools", () => {
  expect(hasPendingUserInputTool([toolItem({ status: "done" })])).toBe(false);
  expect(hasPendingUserInputTool([toolItem({ toolName: "bash" })])).toBe(false);
});
