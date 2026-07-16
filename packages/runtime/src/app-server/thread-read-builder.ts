// @summary Thread read snapshot builder — assembles ThreadItem[] from transcript and applies live collab state.

import { resolveModel } from "@diligent/core/llm/models";
import type { ToolRenderPayload } from "@diligent/protocol";
import { calculateUsageCost } from "../cost";
import type { AssistantMessage, ThreadItem, ToolResultMessage, UserMessage } from "../protocol/index";
import { createToolEndRenderPayloadFromInput, createToolStartRenderPayload } from "../tools/render-strategies";
import type { ThreadRuntime } from "./thread-handlers";

export type ThreadReadTranscriptEntry =
  | { type: "compaction"; id: string; timestamp: string; summary: string; displaySummary?: string }
  | {
      type: "context";
      id: string;
      timestamp: string;
      source: string;
      presentation: import("@diligent/protocol").ContextPresentation;
    }
  | { type: "message"; id: string; timestamp: string; message: UserMessage | AssistantMessage | ToolResultMessage };

function toSnapshotCollabStatus(status: { kind: string }): "running" | "completed" | "errored" | "shutdown" {
  if (status.kind === "completed") return "completed";
  if (status.kind === "errored") return "errored";
  if (status.kind === "shutdown") return "shutdown";
  return "running";
}

function toSnapshotCollabMessage(status: { kind: string; output?: string | null; error?: string }): string | undefined {
  if (status.kind === "completed") return status.output ?? undefined;
  if (status.kind === "errored") return status.error;
  return undefined;
}

export function applyLiveCollabStatusesToSnapshot(items: ThreadItem[], runtime: ThreadRuntime): ThreadItem[] {
  const agents = runtime.agent?.registry?.getKnownAgents() ?? [];
  if (agents.length === 0) {
    return items;
  }

  const statusByThreadId = new Map(
    agents.map((agent) => [
      agent.threadId,
      {
        nickname: agent.nickname,
        description: agent.description || undefined,
        status: toSnapshotCollabStatus(agent.status),
        message: toSnapshotCollabMessage(agent.status),
      },
    ]),
  );

  return items.map((item) => {
    if (item.type !== "collabEvent") {
      return item;
    }

    if (item.eventKind === "spawn" && item.childThreadId) {
      const live = statusByThreadId.get(item.childThreadId);
      if (!live) {
        return item;
      }
      return {
        ...item,
        nickname: item.nickname ?? live.nickname,
        description: item.description ?? live.description,
        status: live.status,
        message: live.message ?? item.message,
      };
    }

    if (item.eventKind === "wait" && item.agents) {
      const nextAgents = item.agents.map((agent) => {
        const live = statusByThreadId.get(agent.threadId);
        if (!live) {
          return agent;
        }
        return {
          ...agent,
          nickname: agent.nickname ?? live.nickname,
          status: live.status,
          message: live.message ?? agent.message,
        };
      });

      const anyStillRunning = nextAgents.some((agent) => agent.status === "running");
      return {
        ...item,
        agents: nextAgents,
        status: anyStillRunning ? "running" : "completed",
        timedOut: anyStillRunning ? item.timedOut : false,
      };
    }

    return item;
  });
}

function mergeToolRenderPayload(
  started: ToolRenderPayload | undefined,
  completed: ToolRenderPayload | undefined,
): ToolRenderPayload | undefined {
  if (!started) return completed;
  if (!completed) return started;
  return {
    ...completed,
    inputSummary: completed.inputSummary ?? started.inputSummary,
    outputSummary: completed.outputSummary ?? started.outputSummary,
  };
}

export function buildThreadReadItems(transcript: ThreadReadTranscriptEntry[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const toolStartsByCallId = new Map<
    string,
    {
      itemId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      startedAt: number;
    }
  >();

  const parseEntryTimestamp = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  for (const entry of transcript) {
    const entryTimestamp = parseEntryTimestamp(entry.timestamp);
    if (entry.type === "context") {
      items.push({
        type: "contextMessage",
        itemId: entry.id,
        source: entry.source,
        presentation: entry.presentation,
        timestamp: entryTimestamp,
      });
      continue;
    }
    if (entry.type === "compaction") {
      items.push({
        type: "compaction",
        itemId: entry.id,
        summary: typeof entry.summary === "string" ? entry.summary : "",
        displaySummary: entry.displaySummary,
        timestamp: entryTimestamp,
        tokensBefore: 0,
        tokensAfter: 0,
      });
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "user") {
      items.push({ type: "userMessage", itemId: entry.id, message, timestamp: message.timestamp });
      continue;
    }

    if (message.role === "assistant") {
      const assistantTimestamp = message.timestamp;
      const assistantCost = calculateUsageCost(resolveModel(message.model), message.usage);
      items.push({
        type: "agentMessage",
        itemId: entry.id,
        message,
        timestamp: assistantTimestamp,
        usage: message.usage,
        cost: assistantCost,
      });

      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        const toolItem = {
          itemId: `tool:${block.id}`,
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
          startedAt: assistantTimestamp,
        };
        toolStartsByCallId.set(block.id, toolItem);
        items.push({
          type: "toolCall",
          itemId: toolItem.itemId,
          toolCallId: toolItem.toolCallId,
          toolName: toolItem.toolName,
          input: toolItem.input,
          timestamp: toolItem.startedAt,
          startedAt: toolItem.startedAt,
          render: createToolStartRenderPayload(toolItem.toolName, toolItem.input),
        });
      }
      continue;
    }

    if (message.role === "tool_result") {
      const start = toolStartsByCallId.get(message.toolCallId);
      const derivedRender = createToolEndRenderPayloadFromInput({
        toolName: message.toolName,
        input: start?.input ?? {},
        output: message.output,
        isError: message.isError,
      });
      const startRender = start ? createToolStartRenderPayload(start.toolName, start.input) : undefined;
      items.push({
        type: "toolCall",
        itemId: start?.itemId ?? `tool:${message.toolCallId}`,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        input: start?.input ?? {},
        timestamp: message.timestamp,
        startedAt: start?.startedAt ?? message.timestamp,
        durationMs: Math.max(0, message.timestamp - (start?.startedAt ?? message.timestamp)),
        output: message.output,
        ...(message.outputImages ? { outputImages: message.outputImages } : {}),
        isError: message.isError,
        render: mergeToolRenderPayload(startRender, message.render ?? derivedRender),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      });
    }
  }

  return items;
}
