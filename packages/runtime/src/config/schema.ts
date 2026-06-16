// @summary Zod schema definitions for DiligentConfig validation and type inference
import { ThinkingEffortSchema } from "@diligent/protocol";
import { z } from "zod";

export const ModelId = z.string().describe("Model identifier, e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-flash'");

const HookCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  mode: z.enum(["sync", "async"]).optional(),
  timeout: z.number().positive().optional(),
});

export const DiligentConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // Core settings
    model: ModelId.optional(),
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
        zai: z
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
    skills: z
      .object({
        enabled: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
      })
      .optional(),

    agents: z
      .object({
        enabled: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
      })
      .optional(),

    // Collaboration mode
    mode: z.enum(["default", "plan", "execute"]).optional(),
    effort: ThinkingEffortSchema.optional(),

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
  })
  .strict();

export type DiligentConfig = z.infer<typeof DiligentConfigSchema>;

export const DEFAULT_CONFIG: DiligentConfig = {
  model: "gemini-3.1-pro-preview",
  effort: "medium",
};
