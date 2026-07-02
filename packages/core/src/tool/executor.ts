// @summary Executes tool calls with parameter validation and auto-truncation
import type { ZodIssue } from "zod";
import type { ToolCallBlock } from "../types";
import {
  MAX_OUTPUT_BYTES,
  persistFullOutput,
  shouldTruncate,
  TRUNCATION_WARNING,
  truncateHead,
  truncateHeadTail,
  truncateTail,
} from "./truncation";
import type { ToolContext, ToolRegistry, ToolResult } from "./types";

type InvalidArgsIssueMetadata = {
  path: string;
  message: string;
  code?: string;
  suggestedFix?: string;
};

type InvalidArgsMetadata = {
  status: { kind: "invalid_args" };
  code: "invalid_args";
  issues?: InvalidArgsIssueMetadata[];
};

type ErrorWithInvalidArgs = Error & {
  invalidArgs?: Partial<InvalidArgsMetadata>;
};

export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCallBlock,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return { output: `Error: Unknown tool "${toolCall.name}"`, metadata: { error: true } };
  }

  let args: unknown;
  if (tool.parseArgs) {
    try {
      args = tool.parseArgs(toolCall.input);
    } catch (err) {
      return {
        output: `Error: Invalid arguments for "${toolCall.name}":\n${err instanceof Error ? err.message : String(err)}`,
        metadata: { error: true, ...invalidArgsMetadataFromError(err) },
      };
    }
  } else {
    const parsed = tool.parameters.safeParse(toolCall.input);
    if (!parsed.success) {
      return {
        output: `Error: Invalid arguments for "${toolCall.name}":\n${parsed.error.issues.map((i: ZodIssue) => `  [${i.path.join(".")}] ${i.message}`).join("\n")}`,
        metadata: { error: true, ...invalidArgsMetadataFromZodIssues(parsed.error.issues) },
      };
    }
    args = parsed.data;
  }

  let result: ToolResult;
  try {
    result = await tool.execute(args, ctx);
    if (result.abortRequested) ctx.abort();
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      output: `Error: Tool "${toolCall.name}" threw an unexpected error: ${message}`,
      metadata: { error: true },
    };
  }

  // D025: Auto-truncation safety net (honors a per-result byte cap when the tool sets one).
  const maxBytes = result.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (shouldTruncate(result.output, maxBytes)) {
    const direction = result.truncateDirection ?? "tail";
    const truncated =
      direction === "head"
        ? truncateHead(result.output, maxBytes)
        : direction === "head_tail"
          ? truncateHeadTail(result.output, maxBytes)
          : truncateTail(result.output, maxBytes);

    const savedPath = await persistFullOutput(result.output);

    return {
      ...result,
      output:
        truncated.output +
        TRUNCATION_WARNING +
        `\n(truncated from ${truncated.originalBytes} bytes. Full output at: ${savedPath})`,
      metadata: {
        ...result.metadata,
        truncated: true,
        truncatedFrom: { bytes: truncated.originalBytes },
        fullOutputPath: savedPath,
      },
      truncateDirection: direction,
    };
  }

  return result;
}

function invalidArgsMetadataFromError(err: unknown): InvalidArgsMetadata {
  const fallback: InvalidArgsMetadata = { status: { kind: "invalid_args" }, code: "invalid_args" };
  if (!(err instanceof Error)) return fallback;

  const invalidArgs = (err as ErrorWithInvalidArgs).invalidArgs;
  if (!invalidArgs || typeof invalidArgs !== "object") return fallback;

  return {
    ...fallback,
    ...invalidArgs,
    status: { kind: "invalid_args" },
    code: "invalid_args",
  };
}

function invalidArgsMetadataFromZodIssues(issues: ZodIssue[]): InvalidArgsMetadata {
  return {
    status: { kind: "invalid_args" },
    code: "invalid_args",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  };
}
