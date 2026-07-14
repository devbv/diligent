// @summary Shows the conversation context around the request that produced a snapshot.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import { findSnapshotById, type SnapshotEntry, truncateLabel } from "./snapshot";

const params = z.object({
  snapshotId: z.string().describe("Snapshot id from studiorpc_snapshot_list."),
});

const description =
  "Show the conversation context around the user request that produced a rollback snapshot. Reads the " +
  "session transcript recorded with the snapshot and returns the matched request plus the entries that " +
  "followed it. Useful when rolling back across sessions, where the current conversation does not contain " +
  "the original request.";

const FOLLOWING_ENTRIES = 4;
const ENTRY_CHAR_CAP = 500;

interface TranscriptMessage {
  role: string;
  text: string;
  timestamp: string;
}

/** Extract plain text from a session message's string-or-blocks content. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Parse "message" entries out of a session JSONL transcript, tolerating bad lines. */
function readTranscriptMessages(transcriptPath: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    if (entry.type !== "message" || !entry.message || typeof entry.message.role !== "string") continue;
    const text = messageText(entry.message.content);
    if (text === undefined) continue;
    messages.push({
      role: entry.message.role,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return messages;
}

function clip(text: string): string {
  return text.length > ENTRY_CHAR_CAP ? `${text.slice(0, ENTRY_CHAR_CAP)}…` : text;
}

function infoResult(output: string): ToolResult {
  return { output, metadata: { method: "snapshot.context" } };
}

export function createSnapshotContextTool(cwd: string): Tool {
  return {
    name: "studiorpc_snapshot_context",
    description,
    parameters: params,
    async execute(rawArgs): Promise<ToolResult> {
      const { snapshotId } = params.parse(rawArgs ?? {});
      let snapshot: SnapshotEntry;
      try {
        snapshot = findSnapshotById(cwd, snapshotId);
      } catch (error) {
        return { output: (error as Error).message, metadata: { error: true, method: "snapshot.context" } };
      }
      const label = snapshot.label;
      if (!snapshot.transcriptPath) {
        return infoResult(
          `Snapshot ${snapshotId} has no transcript reference (captured before transcript recording, or as a pre-rollback safety snapshot).`,
        );
      }
      if (!label) {
        return infoResult(`Snapshot ${snapshotId} has no label to locate in the transcript.`);
      }
      let messages: TranscriptMessage[];
      try {
        messages = readTranscriptMessages(snapshot.transcriptPath);
      } catch {
        return infoResult(
          `The transcript recorded for snapshot ${snapshotId} could not be read (${snapshot.transcriptPath}).`,
        );
      }
      // The label is the opening of the user prompt that started the turn.
      // The same prompt can repeat, so prefer the occurrence closest before
      // the snapshot's capture time.
      const matches = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === "user" && message.text.startsWith(label));
      if (matches.length === 0) {
        return infoResult(
          `The request for snapshot ${snapshotId} was not found in the transcript (it may have been compacted away).`,
        );
      }
      const before = matches.filter(({ message }) => message.timestamp && message.timestamp <= snapshot.createdAt);
      const eligible = before.length > 0 ? before : matches;
      const match = eligible[eligible.length - 1];
      const window = messages.slice(match.index, match.index + 1 + FOLLOWING_ENTRIES);
      const rendered = window.map((m) => `[${m.role}] ${clip(m.text)}`).join("\n");
      return {
        output:
          `Context for snapshot ${snapshot.id} ("${truncateLabel(label)}"), captured at ${snapshot.createdAt}:\n\n` +
          rendered,
        metadata: { method: "snapshot.context", snapshotId: snapshot.id },
      };
    },
  };
}
