// @summary Anthropic tool schemas and provider-native web content mapping
import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock } from "../../../types";
import type { FunctionToolDefinition, ToolDefinition } from "../../types";

type ProviderToolUseBlock = Extract<ContentBlock, { type: "provider_tool_use" }>;
type WebSearchResultBlock = Extract<ContentBlock, { type: "web_search_result" }>;
type WebFetchResultBlock = Extract<ContentBlock, { type: "web_fetch_result" }>;

/**
 * Anthropic rejects `anyOf`/`oneOf`/`allOf` at the top level of a tool `input_schema` — it requires
 * a single object schema. Tool schemas reach us from two runtime sources (zod-to-json-schema output
 * and MCP servers' advertised schemas), either of which can put a union/intersection at the root.
 * Collapse it into one object schema by merging the branches' `properties`. Arguments are validated
 * elsewhere (Zod `parameters` for built-ins, passthrough for MCP), so this only relaxes the
 * model-facing guidance, never the actual call contract. Recurses so nested unions in a branch are
 * flattened too. Anthropic only forbids these keywords at the top level, so we stop after the root.
 */
function flattenTopLevelSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const unionKey = (["allOf", "anyOf", "oneOf"] as const).find((k) => Array.isArray(schema[k]));
  if (!unionKey) return schema;

  const { allOf: _a, anyOf: _b, oneOf: _c, ...rest } = schema;
  const branches = (schema[unionKey] as unknown[])
    .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    .map((b) => flattenTopLevelSchema(b));

  const properties: Record<string, unknown> = {
    ...((rest.properties as Record<string, unknown>) ?? {}),
  };
  const requiredPerBranch: string[][] = [];
  for (const branch of branches) {
    Object.assign(properties, (branch.properties as Record<string, unknown>) ?? {});
    if (Array.isArray(branch.required)) requiredPerBranch.push(branch.required as string[]);
  }

  // `allOf` must satisfy every branch → a key required by any branch stays required.
  // `anyOf`/`oneOf` satisfies just one → require only keys required by all branches.
  const required =
    unionKey === "allOf"
      ? [...new Set(requiredPerBranch.flat())]
      : requiredPerBranch.length > 0
        ? requiredPerBranch.reduce((acc, set) => acc.filter((k) => set.includes(k)))
        : [];

  return {
    ...rest,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function convertTools(tools: ToolDefinition[]): Anthropic.MessageCreateParams["tools"] {
  return tools.flatMap((tool) => {
    if (tool.kind === "provider_builtin" && tool.capability === "web") {
      return [createAnthropicWebTool(tool)];
    }
    if (tool.kind !== "function") return [];
    const t: FunctionToolDefinition = tool;
    return [
      {
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object" as const,
          ...flattenTopLevelSchema(t.inputSchema ?? {}),
        },
      },
    ];
  });
}

function createAnthropicWebTool(tool: Extract<ToolDefinition, { kind: "provider_builtin" }>): Anthropic.Tool {
  const options = tool.options;
  const hasFetchSettings = Boolean(options?.maxContentTokens);
  const webToolType = hasFetchSettings ? "web_fetch_20260209" : "web_search_20260209";
  const userLocation = options?.userLocation;

  return {
    type: webToolType,
    name: hasFetchSettings ? "web_fetch" : "web_search",
    allowed_callers: ["direct"],
    ...(options?.maxUses !== undefined ? { max_uses: options.maxUses } : {}),
    ...(options?.allowedDomains?.length ? { allowed_domains: options.allowedDomains } : {}),
    ...(options?.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
    ...(userLocation ? { user_location: toAnthropicUserLocation(userLocation) } : {}),
    ...(hasFetchSettings ? { max_content_tokens: options?.maxContentTokens } : {}),
  } as unknown as Anthropic.Tool;
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
