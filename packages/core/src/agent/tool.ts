// @summary Tool-call runner for sequential and parallel execution batches

import type { ToolOutputFileStore } from "../tool/executor";
import { executeTool } from "../tool/executor";
import type { ToolContext, ToolRegistry } from "../tool/types";
import type { ToolCallBlock, ToolResultMessage } from "../types";
import type { AgentStream } from "./types";

export async function runToolCalls(
  toolCalls: ToolCallBlock[],
  signal: AbortSignal | undefined,
  registry: ToolRegistry,
  stream: AgentStream,
  generateItemId: () => string,
  onToolAbort: () => void,
  outputStore?: ToolOutputFileStore,
): Promise<{
  executions: Array<{
    toolCall: ToolCallBlock;
    toolResult: ToolResultMessage;
  }>;
}> {
  const executions: Array<{
    toolCall: ToolCallBlock;
    toolResult: ToolResultMessage;
  }> = [];

  if (toolCalls.length === 0) {
    return { executions };
  }

  const buildToolContext = (toolCall: ToolCallBlock, toolItemId: string): ToolContext => ({
    toolCallId: toolCall.id,
    signal: signal ?? new AbortController().signal,
    abort: onToolAbort,
    onUpdate: (partial) => {
      stream.emit({
        type: "tool_update",
        itemId: toolItemId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        partialResult: partial,
      });
    },
  });

  const canRunInParallel =
    toolCalls.length > 1 && toolCalls.every((toolCall) => registry.get(toolCall.name)?.supportParallel);
  const itemIds = toolCalls.map(() => generateItemId());

  if (canRunInParallel) {
    for (let index = 0; index < toolCalls.length; index++) {
      stream.emit({
        type: "tool_start",
        itemId: itemIds[index],
        toolCallId: toolCalls[index].id,
        toolName: toolCalls[index].name,
        input: toolCalls[index].input,
      });
    }

    const results = await Promise.all(
      toolCalls.map((toolCall, index) =>
        executeTool(registry, toolCall, buildToolContext(toolCall, itemIds[index]), { outputStore }),
      ),
    );

    for (let index = 0; index < toolCalls.length; index++) {
      executions.push(toToolCallExecution(toolCalls[index], itemIds[index], results[index], stream));
      if (signal?.aborted) break;
    }

    // Parallel: tool_start was already emitted for every call above.
    fillAbortedExecutions(toolCalls, itemIds, executions, signal, stream, true);
    return { executions };
  }

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    if (signal?.aborted) {
      break;
    }

    stream.emit({
      type: "tool_start",
      itemId: itemIds[index],
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
    });

    const result = await executeTool(registry, toolCall, buildToolContext(toolCall, itemIds[index]), { outputStore });
    executions.push(toToolCallExecution(toolCall, itemIds[index], result, stream));

    if (signal?.aborted) break;
  }

  // Sequential: only executed calls emitted tool_start, so unexecuted ones still need it.
  fillAbortedExecutions(toolCalls, itemIds, executions, signal, stream, false);
  return { executions };
}

/**
 * When a turn is aborted mid-batch, some tool calls may never run (parallel: results
 * after the first are dropped; sequential: later calls never start). Every tool_use
 * still needs a matching tool_result, or the next provider request sends an orphaned
 * tool_use. Synthesize an aborted result for each unexecuted call, emitting tool_start
 * (if not already emitted) + tool_end so the stream, persisted session, and in-memory
 * conversation all stay consistent.
 */
function fillAbortedExecutions(
  toolCalls: ToolCallBlock[],
  itemIds: string[],
  executions: Array<{ toolCall: ToolCallBlock; toolResult: ToolResultMessage }>,
  signal: AbortSignal | undefined,
  stream: AgentStream,
  allStarted: boolean,
): void {
  if (!signal?.aborted) return;
  const executed = new Set(executions.map((execution) => execution.toolCall.id));

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    if (executed.has(toolCall.id)) continue;

    if (!allStarted) {
      stream.emit({
        type: "tool_start",
        itemId: itemIds[index],
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      });
    }

    const toolResult: ToolResultMessage = {
      role: "tool_result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: "[Aborted by user]",
      isError: false,
      timestamp: Date.now(),
    };

    stream.emit({
      type: "tool_end",
      itemId: itemIds[index],
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: toolResult.output,
      isError: false,
    });

    executions.push({ toolCall, toolResult });
  }
}

function toToolCallExecution(
  toolCall: ToolCallBlock,
  itemId: string,
  result: Awaited<ReturnType<typeof executeTool>>,
  stream: AgentStream,
): {
  toolCall: ToolCallBlock;
  toolResult: ToolResultMessage;
} {
  const toolResult: ToolResultMessage = {
    role: "tool_result",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    output: result.output,
    outputImages: result.outputImages,
    isError: !!result.metadata?.error,
    timestamp: Date.now(),
    render: result.render,
    metadata: result.metadata,
  };

  stream.emit({
    type: "tool_end",
    itemId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    output: result.output,
    outputImages: result.outputImages,
    isError: toolResult.isError,
    render: result.render,
    metadata: result.metadata,
  });

  return { toolCall, toolResult };
}
