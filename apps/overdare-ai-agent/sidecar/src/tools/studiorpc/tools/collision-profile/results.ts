// @summary Shared result and approval helpers for collision profile tools.

import { z } from "zod";
import type { ToolContext, ToolResult } from "../../types";

export class CollisionToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CollisionToolError";
  }
}

export function okResult(payload: unknown, metadata: Record<string, unknown> = {}): ToolResult {
  return {
    output: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    metadata: { ...metadata, result: payload },
  };
}

export function errorResult(error: unknown, toolName: string): ToolResult {
  if (error instanceof CollisionToolError) {
    const payload = { success: false, error: { code: error.code, message: error.message } };
    return {
      output: JSON.stringify(payload, null, 2),
      metadata: { error: true, toolName, code: error.code, message: error.message },
    };
  }
  if (error instanceof z.ZodError) {
    const code = error.issues.some((issue) => {
      const lastPath = issue.path.at(-1);
      return issue.code === "invalid_enum_value" && (lastPath === "response" || lastPath === "defaultResponse");
    })
      ? "INVALID_RESPONSE"
      : "INVALID_CHANNEL";
    const message = error.issues.map((issue) => issue.message).join("; ");
    const payload = { success: false, error: { code, message } };
    return {
      output: JSON.stringify(payload, null, 2),
      metadata: { error: true, toolName, code, message },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const payload = { success: false, error: { code: "ERROR", message } };
  return {
    output: JSON.stringify(payload, null, 2),
    metadata: { error: true, toolName, code: "ERROR", message },
  };
}

export async function approveWrite(
  ctx: ToolContext,
  toolName: string,
  description: string,
  details: Record<string, unknown>,
): Promise<ToolResult | undefined> {
  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description,
    details,
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true, toolName } };
  }
  return undefined;
}
