// @summary Diligent client->server request schemas and typed method/result maps
import { z } from "zod";
import {
  ContentBlockSchema,
  KnowledgeEntrySchema,
  LocalImageBlockSchema,
  MessageSchema,
  ModeSchema,
  ProtocolCapabilitiesSchema,
  ProtocolVersionSchema,
  ProviderAuthStatusSchema,
  ProviderNameSchema,
  SerializableErrorSchema,
  SessionSummarySchema,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  ThinkingEffortSchema,
  ThreadItemSchema,
} from "./data-model";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "./methods";

export const InitializeParamsSchema = z.object({
  clientName: z.string(),
  clientVersion: z.string(),
  protocolVersion: ProtocolVersionSchema.default(1),
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  provider: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputCostPer1M: z.number().optional(),
  outputCostPer1M: z.number().optional(),
  supportsThinking: z.boolean(),
  supportedEfforts: z.array(ThinkingEffortSchema).optional(),
  supportsVision: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;

export const InitializeResponseSchema = z.object({
  serverName: z.string(),
  serverVersion: z.string(),
  protocolVersion: z.literal(1),
  capabilities: ProtocolCapabilitiesSchema,
  cwd: z.string().optional(),
  mode: ModeSchema.optional(),
  effort: ThinkingEffortSchema.optional(),
  currentModel: z.string().optional(),
  availableModels: z.array(ModelInfoSchema).optional(),
  skills: z.array(SkillInfoSchema).optional(),
});
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;

export const ThreadStartParamsSchema = z.object({
  cwd: z.string(),
  mode: ModeSchema.optional(),
  effort: ThinkingEffortSchema.optional(),
  model: z.string().optional(),
});
export type ThreadStartParams = z.infer<typeof ThreadStartParamsSchema>;

export const ThreadStartResponseSchema = z.object({
  threadId: z.string(),
});
export type ThreadStartResponse = z.infer<typeof ThreadStartResponseSchema>;

export const ThreadResumeParamsSchema = z
  .object({
    threadId: z.string().optional(),
    mostRecent: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.threadId) || v.mostRecent === true, {
    message: "Either threadId or mostRecent=true is required",
  });
export type ThreadResumeParams = z.infer<typeof ThreadResumeParamsSchema>;

export const ThreadResumeResponseSchema = z.object({
  found: z.boolean(),
  threadId: z.string().optional(),
  context: z.array(MessageSchema).optional(),
});
export type ThreadResumeResponse = z.infer<typeof ThreadResumeResponseSchema>;

export const ThreadListParamsSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  includeChildren: z.boolean().optional(),
});
export type ThreadListParams = z.infer<typeof ThreadListParamsSchema>;

export const ThreadListResponseSchema = z.object({
  data: z.array(SessionSummarySchema),
});
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

export const ThreadReadParamsSchema = z.object({
  threadId: z.string().optional(),
});
export type ThreadReadParams = z.infer<typeof ThreadReadParamsSchema>;

export const ThreadReadResponseSchema = z.object({
  cwd: z.string(),
  items: z.array(ThreadItemSchema),
  errors: z
    .array(
      z.object({
        id: z.string(),
        timestamp: z.string(),
        turnId: z.string().optional(),
        fatal: z.boolean(),
        error: SerializableErrorSchema,
      }),
    )
    .optional(),
  hasFollowUp: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  isRunning: z.boolean(),
  currentEffort: ThinkingEffortSchema,
  currentModel: z.string().optional(),
  totalCost: z.number().nonnegative().optional(),
});
export type ThreadReadResponse = z.infer<typeof ThreadReadResponseSchema>;

export const ThreadCompactStartParamsSchema = z.object({
  threadId: z.string().optional(),
});
export type ThreadCompactStartParams = z.infer<typeof ThreadCompactStartParamsSchema>;

export const ThreadCompactStartResponseSchema = z.object({
  compacted: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  summary: z.string(),
});
export type ThreadCompactStartResponse = z.infer<typeof ThreadCompactStartResponseSchema>;

export const TurnAttachmentSchema = z.object({
  type: z.literal("local_image"),
  path: z.string(),
  mediaType: z.enum(SUPPORTED_IMAGE_MEDIA_TYPES),
  fileName: z.string().optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachmentSchema>;

export const TurnStartParamsSchema = z.object({
  threadId: z.string().optional(),
  message: z.string(),
  attachments: z.array(TurnAttachmentSchema).max(4).optional(),
  content: z.array(ContentBlockSchema).optional(),
  model: z.string().optional(),
});
export type TurnStartParams = z.infer<typeof TurnStartParamsSchema>;

export const TurnStartResponseSchema = z.object({
  accepted: z.literal(true),
});
export type TurnStartResponse = z.infer<typeof TurnStartResponseSchema>;

export const TurnInterruptParamsSchema = z.object({
  threadId: z.string().optional(),
});
export type TurnInterruptParams = z.infer<typeof TurnInterruptParamsSchema>;

export const TurnInterruptResponseSchema = z.object({
  interrupted: z.boolean(),
});
export type TurnInterruptResponse = z.infer<typeof TurnInterruptResponseSchema>;

export const TurnSteerParamsSchema = z.object({
  threadId: z.string().optional(),
  content: z.string(),
  attachments: z.array(TurnAttachmentSchema).max(4).optional(),
  followUp: z.boolean().default(false),
});
export type TurnSteerParams = z.infer<typeof TurnSteerParamsSchema>;

export const TurnSteerResponseSchema = z.object({
  queued: z.literal(true),
});
export type TurnSteerResponse = z.infer<typeof TurnSteerResponseSchema>;

export const ModeSetParamsSchema = z.object({
  threadId: z.string().optional(),
  mode: ModeSchema,
});
export type ModeSetParams = z.infer<typeof ModeSetParamsSchema>;

export const ModeSetResponseSchema = z.object({
  mode: ModeSchema,
});
export type ModeSetResponse = z.infer<typeof ModeSetResponseSchema>;

export const EffortSetParamsSchema = z.object({
  threadId: z.string().optional(),
  effort: ThinkingEffortSchema,
});
export type EffortSetParams = z.infer<typeof EffortSetParamsSchema>;

export const EffortSetResponseSchema = z.object({
  effort: ThinkingEffortSchema,
});
export type EffortSetResponse = z.infer<typeof EffortSetResponseSchema>;

export const KnowledgeListParamsSchema = z.object({
  threadId: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type KnowledgeListParams = z.infer<typeof KnowledgeListParamsSchema>;

export const KnowledgeListResponseSchema = z.object({
  data: z.array(KnowledgeEntrySchema),
});
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponseSchema>;

const KnowledgeTypeParamSchema = z.enum(["pattern", "discovery", "preference", "correction", "backlog"]);

export const KnowledgeUpdateParamsSchema = z
  .object({
    action: z.enum(["upsert", "delete"]),
    threadId: z.string().optional(),
    id: z.string().optional(),
    type: KnowledgeTypeParamSchema.optional(),
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "delete") {
      if (!value.id || value.id.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "id is required for delete action" });
      }
      return;
    }

    if (!value.type) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: "type is required for upsert action" });
    }
    if (!value.content || value.content.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required for upsert action",
      });
    }
  });
export type KnowledgeUpdateParams = z.infer<typeof KnowledgeUpdateParamsSchema>;

export const KnowledgeUpdateResponseSchema = z.object({
  entry: KnowledgeEntrySchema.optional(),
  deleted: z.boolean().optional(),
});
export type KnowledgeUpdateResponse = z.infer<typeof KnowledgeUpdateResponseSchema>;

export const ThreadDeleteParamsSchema = z.object({
  threadId: z.string(),
});
export type ThreadDeleteParams = z.infer<typeof ThreadDeleteParamsSchema>;

export const ThreadDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});
export type ThreadDeleteResponse = z.infer<typeof ThreadDeleteResponseSchema>;

export const ToolConflictPolicySchema = z.enum(["error", "builtin_wins", "plugin_wins"]);
export type ToolConflictPolicy = z.infer<typeof ToolConflictPolicySchema>;

export const ToolStateReasonSchema = z.enum([
  "enabled",
  "disabled_by_user",
  "immutable_forced_on",
  "plugin_disabled",
  "plugin_load_failed",
  "conflict_dropped",
  "invalid_plugin_tool",
  "superseded_by_bundled",
]);
export type ToolStateReason = z.infer<typeof ToolStateReasonSchema>;

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  source: z.enum(["builtin", "plugin"]),
  pluginPackage: z.string().optional(),
  enabled: z.boolean(),
  immutable: z.boolean(),
  configurable: z.boolean(),
  available: z.boolean(),
  reason: ToolStateReasonSchema,
  error: z.string().optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const PluginDescriptorSchema = z.object({
  package: z.string(),
  configured: z.boolean(),
  enabled: z.boolean(),
  loaded: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  loadError: z.string().optional(),
  warnings: z.array(z.string()),
});
export type PluginDescriptor = z.infer<typeof PluginDescriptorSchema>;

export const ToolsListParamsSchema = z.object({
  threadId: z.string().optional(),
});
export type ToolsListParams = z.infer<typeof ToolsListParamsSchema>;

export const ToolsListResponseSchema = z.object({
  configPath: z.string(),
  appliesOnNextTurn: z.literal(true),
  trustMode: z.literal("full_trust"),
  conflictPolicy: ToolConflictPolicySchema,
  tools: z.array(ToolDescriptorSchema),
  plugins: z.array(PluginDescriptorSchema),
});
export type ToolsListResponse = z.infer<typeof ToolsListResponseSchema>;

export const ToolsSetPluginPatchSchema = z.object({
  package: z.string(),
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  remove: z.boolean().optional(),
});
export type ToolsSetPluginPatch = z.infer<typeof ToolsSetPluginPatchSchema>;

export const ToolsSetParamsSchema = z.object({
  threadId: z.string().optional(),
  builtin: z.record(z.string(), z.boolean()).optional(),
  plugins: z.array(ToolsSetPluginPatchSchema).optional(),
  conflictPolicy: ToolConflictPolicySchema.optional(),
});
export type ToolsSetParams = z.infer<typeof ToolsSetParamsSchema>;

export const ToolsSetResponseSchema = ToolsListResponseSchema;
export type ToolsSetResponse = z.infer<typeof ToolsSetResponseSchema>;

// --- config/set ---
export const ConfigSetParamsSchema = z.object({
  threadId: z.string().optional(),
  model: z.string().optional(),
});
export type ConfigSetParams = z.infer<typeof ConfigSetParamsSchema>;

export const ConfigSetResponseSchema = z.object({
  model: z.string().optional(),
});
export type ConfigSetResponse = z.infer<typeof ConfigSetResponseSchema>;

// --- auth/list ---
export const AuthListParamsSchema = z.object({});
export type AuthListParams = z.infer<typeof AuthListParamsSchema>;

export const AuthListResponseSchema = z.object({
  providers: z.array(ProviderAuthStatusSchema),
  availableModels: z.array(ModelInfoSchema),
});
export type AuthListResponse = z.infer<typeof AuthListResponseSchema>;

// --- auth/set ---
export const AuthSetParamsSchema = z.object({
  provider: ProviderNameSchema,
  apiKey: z.string().min(1),
});
export type AuthSetParams = z.infer<typeof AuthSetParamsSchema>;

export const AuthSetResponseSchema = z.object({
  ok: z.literal(true),
});
export type AuthSetResponse = z.infer<typeof AuthSetResponseSchema>;

// --- auth/remove ---
export const AuthRemoveParamsSchema = z.object({
  provider: ProviderNameSchema,
});
export type AuthRemoveParams = z.infer<typeof AuthRemoveParamsSchema>;

export const AuthRemoveResponseSchema = z.object({
  ok: z.literal(true),
});
export type AuthRemoveResponse = z.infer<typeof AuthRemoveResponseSchema>;

// --- auth/oauth/start ---
export const AuthOAuthStartParamsSchema = z.object({
  provider: z.literal("chatgpt"),
});
export type AuthOAuthStartParams = z.infer<typeof AuthOAuthStartParamsSchema>;

export const AuthOAuthStartResponseSchema = z.object({
  authUrl: z.string().url(),
});
export type AuthOAuthStartResponse = z.infer<typeof AuthOAuthStartResponseSchema>;

// --- auth/oauth/cancel ---
export const AuthOAuthCancelParamsSchema = z.object({
  provider: z.literal("chatgpt"),
});
export type AuthOAuthCancelParams = z.infer<typeof AuthOAuthCancelParamsSchema>;

export const AuthOAuthCancelResponseSchema = z.object({
  cancelled: z.boolean(),
});
export type AuthOAuthCancelResponse = z.infer<typeof AuthOAuthCancelResponseSchema>;

// --- thread/subscribe ---
export const ThreadSubscribeParamsSchema = z.object({
  threadId: z.string(),
});
export type ThreadSubscribeParams = z.infer<typeof ThreadSubscribeParamsSchema>;

export const ThreadSubscribeResponseSchema = z.object({
  subscriptionId: z.string(),
});
export type ThreadSubscribeResponse = z.infer<typeof ThreadSubscribeResponseSchema>;

// --- thread/unsubscribe ---
export const ThreadUnsubscribeParamsSchema = z.object({
  subscriptionId: z.string(),
});
export type ThreadUnsubscribeParams = z.infer<typeof ThreadUnsubscribeParamsSchema>;

export const ThreadUnsubscribeResponseSchema = z.object({
  ok: z.boolean(),
});
export type ThreadUnsubscribeResponse = z.infer<typeof ThreadUnsubscribeResponseSchema>;

// --- image/upload ---
export const ImageUploadParamsSchema = z.object({
  threadId: z.string().optional(),
  fileName: z.string().min(1),
  mediaType: z.enum(SUPPORTED_IMAGE_MEDIA_TYPES),
  dataBase64: z.string().min(1),
});
export type ImageUploadParams = z.infer<typeof ImageUploadParamsSchema>;

export const ImageUploadAttachmentSchema = LocalImageBlockSchema.extend({
  webUrl: z.string().optional(),
});
export type ImageUploadAttachment = z.infer<typeof ImageUploadAttachmentSchema>;

export const ImageUploadResponseSchema = z.object({
  attachment: ImageUploadAttachmentSchema,
});
export type ImageUploadResponse = z.infer<typeof ImageUploadResponseSchema>;

export const DiligentClientRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE), params: InitializeParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START), params: ThreadStartParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME), params: ThreadResumeParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_LIST), params: ThreadListParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ), params: ThreadReadParamsSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START),
    params: ThreadCompactStartParamsSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START), params: TurnStartParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT), params: TurnInterruptParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER), params: TurnSteerParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET), params: ModeSetParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET), params: EffortSetParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST), params: KnowledgeListParamsSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE),
    params: KnowledgeUpdateParamsSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE), params: ThreadDeleteParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST), params: ToolsListParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET), params: ToolsSetParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET), params: ConfigSetParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_LIST), params: AuthListParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_SET), params: AuthSetParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_REMOVE), params: AuthRemoveParamsSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_START), params: AuthOAuthStartParamsSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_CANCEL),
    params: AuthOAuthCancelParamsSchema,
  }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE),
    params: ThreadSubscribeParamsSchema,
  }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_UNSUBSCRIBE),
    params: ThreadUnsubscribeParamsSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.IMAGE_UPLOAD), params: ImageUploadParamsSchema }),
]);
export type DiligentClientRequest = z.infer<typeof DiligentClientRequestSchema>;

export const DiligentClientResponseSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.INITIALIZE), result: InitializeResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START), result: ThreadStartResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME), result: ThreadResumeResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_LIST), result: ThreadListResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ), result: ThreadReadResponseSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_COMPACT_START),
    result: ThreadCompactStartResponseSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_START), result: TurnStartResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_INTERRUPT), result: TurnInterruptResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TURN_STEER), result: TurnSteerResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.MODE_SET), result: ModeSetResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.EFFORT_SET), result: EffortSetResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST), result: KnowledgeListResponseSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE),
    result: KnowledgeUpdateResponseSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE), result: ThreadDeleteResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST), result: ToolsListResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET), result: ToolsSetResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET), result: ConfigSetResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_LIST), result: AuthListResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_SET), result: AuthSetResponseSchema }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_REMOVE), result: AuthRemoveResponseSchema }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_START),
    result: AuthOAuthStartResponseSchema,
  }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.AUTH_OAUTH_CANCEL),
    result: AuthOAuthCancelResponseSchema,
  }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE),
    result: ThreadSubscribeResponseSchema,
  }),
  z.object({
    method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_UNSUBSCRIBE),
    result: ThreadUnsubscribeResponseSchema,
  }),
  z.object({ method: z.literal(DILIGENT_CLIENT_REQUEST_METHODS.IMAGE_UPLOAD), result: ImageUploadResponseSchema }),
]);
export type DiligentClientResponse = z.infer<typeof DiligentClientResponseSchema>;
