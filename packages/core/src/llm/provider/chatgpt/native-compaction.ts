// @summary ChatGPT subscription native compaction request and response handling
import { arch, platform, release } from "node:os";
import type { OpenAIOAuthTokens } from "../../../auth/types";
import { flattenSections } from "../../system-sections";
import type { NativeCompactFn } from "../native-compaction";
import { readOpenAIFamilyCompactErrorBody } from "../openai/compact-errors";
import { isGpt56Model, toResponseInputItems, toResponsesLiteRequestBody } from "../openai/responses";
import { describeCompactionPayload, extractCompactionSummaryItem } from "../openai/shared";

const CHATGPT_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const CHATGPT_JSON_CONTENT_TYPE = "application/json";
const CHATGPT_CODEX_CLIENT_VERSION = "0.144.1";
const USER_AGENT = `diligent (${platform()} ${release()}; ${arch()})`;

function resolveChatGPTModelId(modelId: string): string {
  return modelId.startsWith("chatgpt-") ? `gpt-${modelId.slice("chatgpt-".length)}` : modelId;
}

export function createChatGPTNativeCompaction(getTokens: () => OpenAIOAuthTokens): NativeCompactFn {
  return async (input) => {
    const tokens = getTokens();
    const upstreamModelId = resolveChatGPTModelId(input.model.id);
    const useResponsesLite = isGpt56Model(upstreamModelId);
    const headers: Record<string, string> = {
      "Content-Type": CHATGPT_JSON_CONTENT_TYPE,
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": USER_AGENT,
      originator: "diligent",
      version: CHATGPT_CODEX_CLIENT_VERSION,
    };
    if (tokens.account_id) headers["ChatGPT-Account-ID"] = tokens.account_id;
    if (input.sessionId) headers.session_id = input.sessionId;
    if (useResponsesLite) headers[RESPONSES_LITE_HEADER] = "true";

    const standardBody: Record<string, unknown> = {
      model: upstreamModelId,
      input: await toResponseInputItems({
        messages: input.messages,
        compactionSummary: input.compactionSummary,
        localImageLoader: input.localImageLoader,
        provider: "chatgpt",
      }),
    };
    if (input.systemPrompt.length > 0) standardBody.instructions = flattenSections(input.systemPrompt);
    const body = useResponsesLite ? toResponsesLiteRequestBody(standardBody) : standardBody;

    const response = await fetch(CHATGPT_COMPACT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });

    if (!response.ok) {
      const errorBody = await readOpenAIFamilyCompactErrorBody(response, ["code", "type", "message"]);
      if (response.status === 404 || response.status === 405) {
        return { status: "unsupported", reason: `status_${response.status}` };
      }
      const suffix = errorBody ? ` body=${errorBody}` : "";
      throw new Error(`ChatGPT native compaction failed (${response.status})${suffix}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const compactionSummary = extractCompactionSummaryItem(payload);
    if (!compactionSummary) {
      return { status: "unsupported", reason: `missing_summary ${describeCompactionPayload(payload)}` };
    }
    return { status: "ok", compactionSummary };
  };
}
