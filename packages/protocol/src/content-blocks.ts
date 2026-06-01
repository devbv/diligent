// @summary Zod schemas for content block types in Diligent protocol messages
import { z } from "zod";

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  citations: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("web_search_result_location"),
          url: z.string(),
          title: z.string().optional(),
          encryptedIndex: z.string().optional(),
          citedText: z.string().optional(),
        }),
        z.object({
          type: z.literal("char_location"),
          documentIndex: z.number().int().nonnegative(),
          documentTitle: z.string().optional(),
          startCharIndex: z.number().int().nonnegative(),
          endCharIndex: z.number().int().nonnegative(),
          citedText: z.string().optional(),
        }),
      ]),
    )
    .optional(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const SUPPORTED_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.enum(SUPPORTED_IMAGE_MEDIA_TYPES),
    data: z.string(),
  }),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const LocalImageBlockSchema = z.object({
  type: z.literal("local_image"),
  path: z.string(),
  mediaType: z.enum(SUPPORTED_IMAGE_MEDIA_TYPES),
  fileName: z.string().optional(),
});
export type LocalImageBlock = z.infer<typeof LocalImageBlockSchema>;

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  providerMetadata: z.record(z.unknown()).optional(),
});
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;

/**
 * ProviderToolUseBlock — provider-native capability block (e.g. web search, web fetch).
 *
 * Extension procedure: when adding a new provider-native capability:
 *   1. Add the new `name` literal to the `name` enum union below (e.g. "code_execution").
 *   2. Add the `provider` literal if a new provider is being introduced.
 *   3. Update consumer switch statements in:
 *      - packages/web/src/client/components/AssistantContentBlocks.tsx
 *      - packages/cli/src/tui/components/thread-store-utils.ts
 *   4. Add an e2e scenario to packages/e2e/provider-native-blocks.test.ts.
 *
 * The `name` and `provider` enums here are the authoritative contract; every consumer
 * that branches on these values must be updated together to avoid silent miss-branches.
 */
export const ProviderToolUseBlockSchema = z.object({
  type: z.literal("provider_tool_use"),
  id: z.string(),
  provider: z.enum(["openai", "chatgpt", "anthropic", "gemini"]),
  name: z.enum(["web_search", "web_fetch"]),
  input: z.record(z.unknown()),
});
export type ProviderToolUseBlock = z.infer<typeof ProviderToolUseBlockSchema>;

export const WebSearchResultSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  pageAge: z.string().optional(),
  snippet: z.string().optional(),
  encryptedContent: z.string().optional(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchResultBlockSchema = z.object({
  type: z.literal("web_search_result"),
  toolUseId: z.string(),
  provider: z.enum(["openai", "chatgpt", "anthropic", "gemini"]),
  results: z.array(WebSearchResultSchema),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
});
export type WebSearchResultBlock = z.infer<typeof WebSearchResultBlockSchema>;

export const WebFetchDocumentSchema = z.object({
  mimeType: z.string(),
  text: z.string().optional(),
  base64Data: z.string().optional(),
  title: z.string().optional(),
  citationsEnabled: z.boolean().optional(),
});
export type WebFetchDocument = z.infer<typeof WebFetchDocumentSchema>;

export const WebFetchResultBlockSchema = z.object({
  type: z.literal("web_fetch_result"),
  toolUseId: z.string(),
  provider: z.enum(["openai", "chatgpt", "anthropic", "gemini"]),
  url: z.string(),
  document: WebFetchDocumentSchema.optional(),
  retrievedAt: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
});
export type WebFetchResultBlock = z.infer<typeof WebFetchResultBlockSchema>;

export const ContentBlockSchema = z.union([
  TextBlockSchema,
  ImageBlockSchema,
  LocalImageBlockSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
  ProviderToolUseBlockSchema,
  WebSearchResultBlockSchema,
  WebFetchResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
