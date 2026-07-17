// @summary OpenAI Responses native compaction request and response handling
import { flattenSections } from "../../system-sections";
import type { NativeCompactFn } from "../native-compaction";
import { readOpenAIFamilyCompactErrorBody } from "./compact-errors";
import { type OpenAIImageDetail, toResponseInputItems } from "./responses";
import { describeCompactionPayload, extractCompactionSummaryItem } from "./shared";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function formatUnsupportedReason(status: number, errorBody: string): string {
  if (!errorBody) return `status_${status}`;
  return `status_${status} body=${errorBody}`;
}

function resolveOpenAIBaseUrl(baseUrl?: string): string {
  const resolved = (baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
  return resolved.endsWith("/v1") ? resolved : `${resolved}/v1`;
}

export function createOpenAINativeCompaction(
  apiKey: string,
  baseUrl?: string,
  imageDetail?: OpenAIImageDetail,
): NativeCompactFn {
  const compactEndpoint = `${resolveOpenAIBaseUrl(baseUrl)}/responses/compact`;
  return async (input) => {
    const body: Record<string, unknown> = {
      model: input.model.id,
      input: await toResponseInputItems({
        messages: input.messages,
        compactionSummary: input.compactionSummary,
        imageDetail,
        localImageLoader: input.localImageLoader,
        provider: "openai",
      }),
    };
    if (input.systemPrompt.length > 0) body.instructions = flattenSections(input.systemPrompt);

    const response = await fetch(compactEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorBody = await readOpenAIFamilyCompactErrorBody(response, ["code", "type", "param", "message"]);
      if (response.status === 400 || response.status === 404 || response.status === 405) {
        return { status: "unsupported", reason: formatUnsupportedReason(response.status, errorBody) };
      }
      const suffix = errorBody ? ` body=${errorBody}` : "";
      throw new Error(`OpenAI native compaction failed (${response.status})${suffix}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const compactionSummary = extractCompactionSummaryItem(payload);
    if (!compactionSummary) {
      return { status: "unsupported", reason: `missing_summary ${describeCompactionPayload(payload)}` };
    }
    return { status: "ok", compactionSummary };
  };
}
