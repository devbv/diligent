import { describe, expect, it } from "bun:test";
import type { ApprovalRequest, ApprovalResponse, ToolContext } from "../src/tool/types";

describe("D086: ApprovalRequest / ApprovalResponse", () => {
  it("ApprovalRequest includes toolName and details", () => {
    const request: ApprovalRequest = {
      permission: "execute",
      toolName: "bash",
      description: "Run command: rm -rf /tmp/test",
      details: { command: "rm -rf /tmp/test" },
    };

    expect(request.toolName).toBe("bash");
    expect(request.details?.command).toBe("rm -rf /tmp/test");
  });

  it("ApprovalResponse type covers once/always/reject", () => {
    const responses: ApprovalResponse[] = ["once", "always", "reject"];
    expect(responses).toHaveLength(3);
  });

  it("auto-approve stub returns 'once'", async () => {
    const ctx: ToolContext = {
      toolCallId: "tc-1",
      signal: new AbortController().signal,
      approve: async () => "once" as const,
    };

    const result = await ctx.approve({
      permission: "read",
      toolName: "read",
      description: "Read file: test.txt",
    });

    expect(result).toBe("once");
  });

  it("ApprovalResponse values can drive proceed/reject logic", () => {
    function shouldProceed(response: ApprovalResponse): boolean {
      return response === "once" || response === "always";
    }

    expect(shouldProceed("once")).toBe(true);
    expect(shouldProceed("always")).toBe(true);
    expect(shouldProceed("reject")).toBe(false);
  });
});
