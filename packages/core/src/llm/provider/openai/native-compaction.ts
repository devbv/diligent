// @summary OpenAI Responses native compaction request and response handling
import { flattenSections } from "../../system-sections";
import type { NativeCompactFn } from "../native-compaction";
import { readOpenAIFamilyCompactError } from "./compact-errors";
import { type OpenAIImageDetail, toResponseInputItems } from "./responses";
import { classifyOpenAIFamilyError, describeCompactionPayload, extractOpenAICompactionState } from "./shared";

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
      model: input.model.modelId,
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
      const errorBody = await readOpenAIFamilyCompactError(response, ["code", "type", "param", "message"]);
      if (response.status === 404 || response.status === 405) {
        return { status: "unsupported", reason: formatUnsupportedReason(response.status, errorBody.formatted) };
      }
      const suffix = errorBody.formatted ? ` body=${errorBody.formatted}` : "";
      const message = `OpenAI native compaction failed (${response.status})${suffix}`;
      const cause = Object.assign(new Error(errorBody.message ?? message), {
        ...(errorBody.code ? { code: errorBody.code } : {}),
        ...(errorBody.type ? { type: errorBody.type } : {}),
        ...(errorBody.param ? { param: errorBody.param } : {}),
      });
      throw classifyOpenAIFamilyError({
        message,
        status: response.status,
        code: errorBody.code,
        cause,
      });
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const compactionSummary = extractOpenAICompactionState(payload);
    if (!compactionSummary) {
      return { status: "unsupported", reason: `missing_summary ${describeCompactionPayload(payload)}` };
    }
    return { status: "ok", compactionSummary };
  };
}
