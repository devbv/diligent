// @summary Unit tests for buildMcpNeedsAuthNote system-prompt section builder

import { describe, expect, test } from "bun:test";
import type { McpServerStatus } from "../../../src/tools/mcp";
import { buildMcpNeedsAuthNote } from "../../../src/tools/mcp";

function status(
  name: string,
  s: McpServerStatus["status"],
  transport: McpServerStatus["transport"] = "http",
): McpServerStatus {
  return { name, transport, status: s, toolCount: 0 };
}

describe("buildMcpNeedsAuthNote", () => {
  test("returns undefined when no servers need auth", () => {
    expect(buildMcpNeedsAuthNote([])).toBeUndefined();
    expect(
      buildMcpNeedsAuthNote([
        status("github", "connected", "stdio"),
        status("notion", "error"),
        status("linear", "disabled"),
      ]),
    ).toBeUndefined();
  });

  test("lists only needs_auth servers with a /mcp login hint", () => {
    const note = buildMcpNeedsAuthNote([
      status("atlassian", "needs_auth"),
      status("github", "connected", "stdio"),
      status("linear", "needs_auth"),
    ]);
    expect(note).toBeDefined();
    expect(note).toContain("/mcp login atlassian");
    expect(note).toContain("/mcp login linear");
    // Connected servers must not be mentioned.
    expect(note).not.toContain("github");
    // The agent must be steered away from attempting the tools.
    expect(note?.toLowerCase()).toContain("not authenticated");
  });
});
