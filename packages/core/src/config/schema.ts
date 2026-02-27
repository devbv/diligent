import { z } from "zod";

export const ModelId = z.string().describe("Model identifier, e.g. 'claude-sonnet-4-20250514'");

export const DiligentConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // Core settings
    model: ModelId.optional(),
    provider: z
      .object({
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
          })
          .optional(),
      })
      .optional(),

    // Agent behavior
    maxTurns: z.number().int().positive().optional(),
    maxRetries: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),

    // Instructions (D034: concatenated across layers)
    instructions: z.array(z.string()).optional(),

    // Session settings
    session: z
      .object({
        autoResume: z.boolean().optional(),
      })
      .optional(),

    // Knowledge settings (prepared for Phase 3b)
    knowledge: z
      .object({
        enabled: z.boolean().optional(),
        nudgeInterval: z.number().int().positive().optional(),
        injectionBudget: z.number().int().positive().optional(),
      })
      .optional(),

    // Compaction settings (prepared for Phase 3b)
    compaction: z
      .object({
        enabled: z.boolean().optional(),
        reserveTokens: z.number().int().positive().optional(),
        keepRecentTokens: z.number().int().positive().optional(),
      })
      .optional(),

    // Skills settings (Phase 4b)
    skills: z
      .object({
        enabled: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
      })
      .optional(),

    // Collaboration mode (Phase 4c)
    mode: z.enum(["default", "plan", "execute"]).optional(),
  })
  .strict();

export type DiligentConfig = z.infer<typeof DiligentConfigSchema>;

export const DEFAULT_CONFIG: DiligentConfig = {
  model: "claude-sonnet-4-20250514",
};
