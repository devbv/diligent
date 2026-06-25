// @summary Shared helper functions and constants for thread state manipulation

import { normalizeToolName } from "@diligent/protocol";
import { toWebImageUrl } from "../../shared/image-routes";
import type { PlanState, RenderItem, ThreadState, UsageState } from "./thread-store";

export { normalizeToolName };

/** Tools that produce collab RenderItems — suppress duplicate ToolBlock rendering. */
export const COLLAB_RENDERED_TOOLS = new Set(["spawn_agent", "wait", "close_agent"]);

export function hasPendingUserInputTool(items: RenderItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === "tool" && item.status === "streaming" && normalizeToolName(item.toolName) === "request_user_input",
  );
}

export const zeroUsage: UsageState = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCost: 0,
};

export function addSeen(state: ThreadState, key: string): ThreadState {
  if (state.seenKeys[key]) return state;
  return {
    ...state,
    seenKeys: {
      ...state.seenKeys,
      [key]: true,
    },
  };
}

export function withItem(state: ThreadState, key: string, item: RenderItem): ThreadState {
  const seenState = addSeen(state, key);
  if (seenState === state) return state;
  return {
    ...seenState,
    items: [...seenState.items, item],
  };
}

export function updateItem(state: ThreadState, itemId: string, updater: (item: RenderItem) => RenderItem): ThreadState {
  const index = state.items.findIndex((item) => item.id === itemId);
  if (index < 0) return state;

  const nextItems = [...state.items];
  nextItems[index] = updater(nextItems[index]);
  return {
    ...state,
    items: nextItems,
  };
}

export function stringifyUnknown(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    const json = JSON.stringify(value, null, 2);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

export function extractUserTextAndImages(content: unknown): {
  text: string;
  images: Array<{ url: string; fileName?: string; mediaType?: string }>;
} {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: stringifyUnknown(content), images: [] };
  }

  const textParts: string[] = [];
  const images: Array<{ url: string; fileName?: string; mediaType?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      textParts.push((block as { text: string }).text);
    }
    if (block.type === "local_image") {
      const b = block as { path: string; fileName?: string; mediaType?: string };
      images.push({ url: toWebImageUrl(b.path), fileName: b.fileName, mediaType: b.mediaType });
    }
  }

  return { text: textParts.join("\n\n"), images };
}

/** Parses plan tool output JSON into PlanState. Returns null if invalid. */
export function parsePlanOutput(output: string): PlanState | null {
  try {
    const parsed = JSON.parse(output) as {
      title?: string;
      steps?: Array<{ text: string; status?: "pending" | "in_progress" | "done" | "cancelled" }>;
    };
    if (parsed && Array.isArray(parsed.steps)) {
      return {
        title: parsed.title ?? "Plan",
        steps: parsed.steps.map((s) => ({
          text: s.text,
          status: s.status ?? "pending",
        })),
      };
    }
  } catch {
    // not valid plan JSON
  }
  return null;
}
