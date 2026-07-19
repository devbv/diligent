// @summary Scans committed session history to restore sub-agent (collab) metadata on resume

import type { ToolCallBlock } from "@diligent/core/message-contract";
import type { ModelClass } from "@diligent/core/model-registry";
import type { CollabResumePolicy } from "../collab/types";
import type { SessionEntry } from "./types";

export interface HistoricalCollabAgent {
  threadId: string;
  nickname: string;
  policy?: Omit<CollabResumePolicy, "modelClass"> & { modelClass?: ModelClass };
}

export class CollabSessionHandler {
  constructor(private getCommittedEntries: () => SessionEntry[]) {}

  /** Scan session entries for spawn_agent tool results to restore collab thread IDs on resume. */
  getHistoricalCollabAgents(): HistoricalCollabAgent[] {
    const results: HistoricalCollabAgent[] = [];
    const spawnCalls = new Map<string, HistoricalCollabAgent["policy"]>();
    for (const entry of this.getCommittedEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        for (const block of entry.message.content) {
          if (block.type === "tool_call" && block.name === "spawn_agent") {
            spawnCalls.set(block.id, policyFromSpawnCall(block));
          }
        }
        continue;
      }
      if (
        entry.type === "message" &&
        entry.message.role === "tool_result" &&
        (entry.message as { toolName?: string }).toolName === "spawn_agent" &&
        !(entry.message as { isError?: boolean }).isError
      ) {
        try {
          const parsed = JSON.parse((entry.message as { output: string }).output);
          if (parsed.thread_id && parsed.nickname) {
            const policy = spawnCalls.get(entry.message.toolCallId);
            results.push({ threadId: parsed.thread_id, nickname: parsed.nickname, ...(policy && { policy }) });
          }
        } catch {
          // skip malformed output
        }
      }
    }
    return results;
  }
}

function policyFromSpawnCall(block: ToolCallBlock): HistoricalCollabAgent["policy"] {
  if (!isRecord(block.input)) return undefined;
  const modelClass = isModelClass(block.input.model_class) ? block.input.model_class : undefined;
  const allowedTools =
    Array.isArray(block.input.allowed_tools) && block.input.allowed_tools.every((item) => typeof item === "string")
      ? [...block.input.allowed_tools]
      : undefined;
  return {
    agentType: typeof block.input.agent_type === "string" ? block.input.agent_type : "general",
    ...(modelClass && { modelClass }),
    ...(allowedTools?.length && { allowedTools }),
    allowNestedAgents: block.input.allow_nested_agents === true,
  };
}

function isModelClass(value: unknown): value is ModelClass {
  return value === "pro" || value === "general" || value === "lite";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
