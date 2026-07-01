// @summary Unit tests for tool name normalization integration in tool-info helpers

import { expect, test } from "bun:test";
import { normalizeToolName } from "../../../src/client/lib/thread-utils";
import { getToolInfo, isBashTool } from "../../../src/client/lib/tool-info";

test("normalizeToolName strips namespace separators", () => {
  expect(normalizeToolName("request_user_input")).toBe("request_user_input");
  expect(normalizeToolName("functions.request_user_input")).toBe("request_user_input");
  expect(normalizeToolName("overdare/request_user_input")).toBe("request_user_input");
});

test("getToolInfo maps namespaced built-in tools", () => {
  expect(getToolInfo("overdare/request_user_input").displayName).toBe("Input");
  expect(getToolInfo("functions.spawn_agent").displayName).toBe("Spawn");
  expect(getToolInfo("functions.multi_edit").activity.done).toBe("Edited files");
  expect(getToolInfo("skill").activity.done).toBe("Loaded skill");
  expect(getToolInfo("search_knowledge").activity.running).toBe("Searching knowledge");
});

test("isBashTool recognizes namespaced bash", () => {
  expect(isBashTool("bash")).toBe(true);
  expect(isBashTool("functions.bash")).toBe(true);
  expect(isBashTool("overdare/grep")).toBe(false);
});
