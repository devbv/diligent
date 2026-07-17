// @summary Anthropic native compaction request and response handling
import type { NativeCompactFn } from "../native-compaction";
import { convertMessages, ensureAnthropicCompactionConversationEndsWithUser } from "./messages";
import { toAnthropicBlocks } from "./request";

function resolveAnthropicBaseUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return resolved.endsWith("/v1") ? resolved : `${resolved}/v1`;
}

function extractAnthropicCompactionSummary(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const rawBlock of content) {
    if (!isRecord(rawBlock) || rawBlock.type !== "compaction") continue;
    if (typeof rawBlock.content !== "string" || !rawBlock.content.trim()) continue;
    const block: Record<string, unknown> = { type: "compaction", content: rawBlock.content };
    if (isRecord(rawBlock.cache_control)) block.cache_control = rawBlock.cache_control;
    return block;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createAnthropicNativeCompaction(apiKey: string, baseUrl?: string): NativeCompactFn {
  const endpoint = `${resolveAnthropicBaseUrl(baseUrl)}/messages`;
  return async (input) => {
    const rawMessages = await convertMessages(input.messages, input.compactionSummary, input.localImageLoader);
    const normalizedMessages = ensureAnthropicCompactionConversationEndsWithUser(rawMessages);
    const body: Record<string, unknown> = {
      model: input.model.id,
      max_tokens: Math.max(256, Math.min(input.model.maxOutputTokens, 4_096)),
      messages: normalizedMessages,
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 50_000 },
            pause_after_compaction: true,
          },
        ],
      },
    };
    if (input.systemPrompt.length > 0) body.system = toAnthropicBlocks(input.systemPrompt);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "compact-2026-01-12",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorDetails = await readErrorBody(response);
      if (response.status === 400 || response.status === 404 || response.status === 405 || response.status === 422) {
        return {
          status: "unsupported",
          reason: errorDetails ? `status_${response.status} ${errorDetails}` : `status_${response.status}`,
        };
      }
      throw new Error(
        errorDetails
          ? `Anthropic native compaction failed (${response.status}) ${errorDetails}`
          : `Anthropic native compaction failed (${response.status})`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const compactionSummary = extractAnthropicCompactionSummary(payload.content);
    const summary = typeof compactionSummary?.content === "string" ? compactionSummary.content : undefined;
    const stopReason = typeof payload.stop_reason === "string" ? payload.stop_reason : undefined;
    const payloadKeys = Object.keys(payload).slice(0, 8).join(",") || "none";
    if (!summary?.trim() || !compactionSummary) {
      return {
        status: "unsupported",
        reason: `missing_compaction_block stop_reason=${stopReason ?? "-"} payload_keys=${payloadKeys}`,
      };
    }
    return { status: "ok", summary, compactionSummary };
  };
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      return JSON.stringify(payload);
    } catch {
      return undefined;
    }
  }

  try {
    const text = (await response.text()).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
