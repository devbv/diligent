// @summary Anthropic tool schemas and provider-native web content mapping
import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock } from "../../../types";
import type { FunctionToolDefinition, ToolDefinition } from "../../types";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

export function convertTools(tools: ToolDefinition[]): Anthropic.MessageCreateParams["tools"] {
  const converted: NonNullable<Anthropic.MessageCreateParams["tools"]> = [];
  for (const tool of tools) {
    if (tool.kind === "provider_builtin" && tool.capability === "web") {
      converted.push(createAnthropicWebTool(tool));
      continue;
    }
    if (tool.kind !== "function") continue;
    const t: FunctionToolDefinition = tool;
    converted.push({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    });
  }
  return converted;
}

function createAnthropicWebTool(
  tool: Extract<ToolDefinition, { kind: "provider_builtin" }>,
): Anthropic.Messages.WebSearchTool20260209 | Anthropic.Messages.WebFetchTool20260209 {
  const options = tool.options;
  const hasFetchSettings = Boolean(options?.maxContentTokens);
  const shared = {
    // Diligent intentionally uses the current GA tools in direct-only mode. This
    // keeps ZDR-compatible server execution and opts out of dynamic filtering.
    allowed_callers: ["direct"] as Array<"direct">,
    ...(options?.maxUses !== undefined ? { max_uses: options.maxUses } : {}),
    ...(options?.allowedDomains?.length ? { allowed_domains: options.allowedDomains } : {}),
    ...(options?.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
  };

  // Product policy: maxContentTokens selects web_fetch; the generic `web`
  // capability does not otherwise imply a fetch/search distinction.
  if (hasFetchSettings) {
    return {
      ...shared,
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_content_tokens: options?.maxContentTokens,
      ...(options?.citationsEnabled !== undefined ? { citations: { enabled: options.citationsEnabled } } : {}),
    };
  }

  return {
    ...shared,
    type: "web_search_20260209",
    name: "web_search",
    ...(options?.userLocation ? { user_location: toAnthropicUserLocation(options.userLocation) } : {}),
  };
}

function toAnthropicUserLocation(
  location: NonNullable<NonNullable<Extract<ToolDefinition, { kind: "provider_builtin" }>["options"]>["userLocation"]>,
) {
  return {
    type: location.type,
    ...(location.city ? { city: location.city } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.country ? { country: location.country } : {}),
    ...(location.timezone ? { timezone: location.timezone } : {}),
  };
}

export function createProviderToolUseBlock(block: Anthropic.ServerToolUseBlock): ProviderToolUseBlock | undefined {
  if (block.name !== "web_search" && block.name !== "web_fetch") return undefined;
  return {
    type: "provider_tool_use",
    id: block.id,
    provider: "anthropic",
    name: block.name,
    input: isRecord(block.input) ? block.input : {},
  };
}

export function createWebSearchResultBlock(block: Anthropic.WebSearchToolResultBlock): WebSearchResultBlock {
  if (!Array.isArray(block.content)) {
    return {
      type: "web_search_result",
      toolUseId: block.tool_use_id,
      provider: "anthropic",
      results: [],
      error: { code: block.content.error_code },
    };
  }

  return {
    type: "web_search_result",
    toolUseId: block.tool_use_id,
    provider: "anthropic",
    results: block.content.map((result) => ({
      url: result.url,
      title: result.title,
      ...(result.page_age ? { pageAge: result.page_age } : {}),
      ...(result.encrypted_content ? { encryptedContent: result.encrypted_content } : {}),
    })),
  };
}

export function createWebFetchResultBlock(block: Anthropic.WebFetchToolResultBlock): WebFetchResultBlock {
  if (block.content.type === "web_fetch_tool_result_error") {
    return {
      type: "web_fetch_result",
      toolUseId: block.tool_use_id,
      provider: "anthropic",
      url: "",
      error: { code: block.content.error_code },
    };
  }

  return {
    type: "web_fetch_result",
    toolUseId: block.tool_use_id,
    provider: "anthropic",
    url: block.content.url,
    document: {
      mimeType: block.content.content.source.media_type,
      ...(extractFetchText(block.content) ? { text: extractFetchText(block.content) } : {}),
      ...(block.content.content.title ? { title: block.content.content.title } : {}),
      citationsEnabled: true,
    },
    ...(block.content.retrieved_at ? { retrievedAt: block.content.retrieved_at } : {}),
  };
}

function extractFetchText(block: Anthropic.WebFetchBlock): string | undefined {
  const source = block.content.source;
  if (source.type === "text") {
    return source.data;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
