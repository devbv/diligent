// @summary Zod schema definitions for DiligentConfig validation and type inference
import { ModelRefSchema, ThinkingEffortSchema } from "@diligent/protocol";
import { z } from "zod";

const HookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  mode: z.enum(["sync", "async"]).optional(),
  timeout: z.number().positive().optional(),
});

// P069: MCP client — external Model Context Protocol servers exposed as tools.
// Shared fields across both stdio and HTTP transports.
const McpServerSharedShape = {
  enabled: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  // Connect + initial listTools budget (default ~30s).
  startupTimeoutMs: z.number().int().positive().optional(),
  // Per tool-call budget (default ~120s); a hung call aborts instead of stalling the turn.
  toolTimeoutMs: z.number().int().positive().optional(),
};

const McpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  ...McpServerSharedShape,
});

const McpOAuthConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  resource: z.string().optional(),
});

const McpHttpServerSchema = z.object({
  type: z.enum(["http", "sse"]).optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  bearerTokenEnvVar: z.string().optional(),
  oauth: McpOAuthConfigSchema.optional(),
  ...McpServerSharedShape,
});

export const McpServerConfigSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

export const SkillsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  overrides: z.record(z.string(), z.boolean()).optional(),
});

// Global MCP behavior (not per-server). `toolLoading` controls how many MCP tools are exposed
// to the model: `eager` surfaces every tool's full schema; `lazy` exposes only two proxy tools
// (search + run) so schemas load on demand; `auto` (default) uses `lazy` once the exposed tool
// count exceeds `lazyThreshold`, keeping small setups unchanged.
const McpGlobalConfigSchema = z.object({
  toolLoading: z.enum(["auto", "eager", "lazy"]).optional(),
  lazyThreshold: z.number().int().positive().optional(),
  // Cap on a single MCP tool's output (approx tokens; ~4 bytes/token). Larger output is
  // truncated by the executor safety net. A tool may raise its own cap via the MCP `_meta`
  // field `anthropic/maxResultSizeChars`.
  maxOutputTokens: z.number().int().positive().optional(),
  // Emit a console warning when an MCP tool's output exceeds this (approx tokens).
  warnOutputTokens: z.number().int().positive().optional(),
  // Expose resource list/read proxy tools for servers that advertise the capability (default true).
  resources: z.boolean().optional(),
  // Expose prompt list/get proxy tools for servers that advertise the capability (default true).
  prompts: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpGlobalConfig = z.infer<typeof McpGlobalConfigSchema>;
export type McpStdioServerConfig = z.infer<typeof McpStdioServerSchema>;
export type McpHttpServerConfig = z.infer<typeof McpHttpServerSchema>;
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

export const DiligentConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // Core settings
    model: ModelRefSchema.optional(),
    provider: z
      .object({
        auth: z
          .object({
            credentialsStore: z.enum(["file", "keyring", "auto", "ephemeral"]).optional(),
          })
          .optional(),
        anthropic: z
          .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().optional(),
          })
          .optional(),
        openai: z
          .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().optional(),
            // OpenAI vision detail for images: "low" caps each image at ~85 tokens (512px, lossy),
            // "high" keeps full detail (more tokens), "auto" (default) lets the server pick by size.
            imageDetail: z.enum(["auto", "low", "high"]).optional(),
          })
          .optional(),
        gemini: z
          .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().optional(),
          })
          .optional(),
        "zai-coding-plan": z
          .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().optional(),
          })
          .optional(),
        vertex: z
          .object({
            project: z.string().min(1),
            location: z.string().min(1),
            endpoint: z.string().min(1),
            baseUrl: z.string().url().optional(),
            authMode: z.enum(["access_token_command", "access_token", "adc"]).optional(),
            accessToken: z.string().optional(),
            accessTokenCommand: z.string().optional(),
            modelMap: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
      })
      .optional(),

    // Agent behavior
    maxRetries: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),
    systemPromptFile: z.string().optional(),

    // Instructions (D034: concatenated across layers)
    instructions: z.array(z.string()).optional(),

    // Session settings
    session: z
      .object({
        autoResume: z.boolean().optional(),
      })
      .optional(),

    // Knowledge settings
    knowledge: z
      .object({
        enabled: z.boolean().optional(),
        nudgeInterval: z.number().int().positive().optional(),
        injectionBudget: z.number().int().positive().optional(),
        maxItems: z.number().int().positive().optional(),
      })
      .optional(),

    // Compaction settings
    compaction: z
      .object({
        enabled: z.boolean().optional(),
        reservePercent: z.number().min(1).max(100).optional(),
        keepRecentTokens: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),

    // Skills settings
    skills: SkillsConfigSchema.optional(),

    // Product-injected experimental capability groups.
    experiments: z
      .object({
        overrides: z.record(z.string(), z.boolean()).optional(),
      })
      .optional(),

    agents: z
      .object({
        enabled: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
        overrides: z.record(z.string(), z.boolean()).optional(),
      })
      .optional(),

    // Collaboration mode
    mode: z.enum(["default", "plan", "execute"]).optional(),
    effort: ThinkingEffortSchema.optional(),

    // Soft plan reminder cadence: re-inject unfinished plan steps into context after this
    // many agent turns without the plan being surfaced. Unset defaults to 6; 0 disables.
    planReminderIntervalTurns: z.number().int().nonnegative().optional(),

    // Permission rules
    permissions: z
      .array(
        z.object({
          permission: z.enum(["read", "write", "execute"]),
          pattern: z.string(),
          action: z.enum(["allow", "deny", "prompt"]),
        }),
      )
      .optional(),

    // User identifier included in hook inputs (falls back to OS username if unset)
    userId: z.string().optional(),

    // YOLO mode — auto-approve all permission prompts without asking
    yolo: z.boolean().optional(),

    // Notify when a turn completes in terminal clients (TUI/CLI)
    terminalBell: z.boolean().optional(),

    // Lifecycle hooks — shell commands executed at specific points in the agent loop
    hooks: z
      .object({
        UserPromptSubmit: z.array(HookCommandSchema).optional(),
        Stop: z.array(HookCommandSchema).optional(),
      })
      .optional(),

    // Tool configuration (P032)
    tools: z
      .object({
        web_action: z.boolean().optional(),
        builtin: z.record(z.string(), z.boolean()).optional(),
        plugins: z
          .array(
            z.object({
              package: z.string(),
              enabled: z.boolean().optional().default(true),
              tools: z.record(z.string(), z.boolean()).optional(),
            }),
          )
          .optional(),
        conflictPolicy: z.enum(["error", "builtin_wins", "plugin_wins"]).optional(),
      })
      .optional(),

    // MCP servers (P069) — external Model Context Protocol servers whose tools are
    // exposed to the agent. Merges across global < project via deep object merge.
    mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),

    // Global MCP behavior (tool-loading strategy). See McpGlobalConfigSchema.
    mcp: McpGlobalConfigSchema.optional(),

    // AI-data consent (OVDR-11475 §3.A). Stores the first-run notice acknowledgement
    // and the service-improvement toggle. Absent fields fall back to defaults
    // (service-improvement ON) when resolved.
    consent: z
      .object({
        // Notice version the user acknowledged via the first-run popup; compared
        // against CONSENT_NOTICE_VERSION to decide whether to re-show the popup.
        noticeAcknowledgedVersion: z.string().optional(),
        serviceImprovement: z.boolean().optional(),
        privacyPolicyUrl: z.string().optional(),
        // ISO timestamp of the last consent change (minimal local record).
        updatedAt: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type DiligentConfig = z.infer<typeof DiligentConfigSchema>;

export const DEFAULT_PLAN_REMINDER_INTERVAL_TURNS = 6;

export const DEFAULT_CONFIG: DiligentConfig = {
  effort: "medium",
  planReminderIntervalTurns: DEFAULT_PLAN_REMINDER_INTERVAL_TURNS,
};
