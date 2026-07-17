// @summary Verifies provider-scoped model identity at protocol boundaries
import { describe, expect, it } from "bun:test";
import {
  AssistantMessageSchema,
  ConfigSetParamsSchema,
  InitializeResponseSchema,
  ModelInfoSchema,
  ModelRefSchema,
  ThreadStartParamsSchema,
  TurnStartParamsSchema,
} from "../src";

const model = { provider: "chatgpt", modelId: "gpt-5.5" } as const;

describe("ModelRef protocol contract", () => {
  it("accepts provider-scoped references and rejects legacy scalar IDs", () => {
    expect(ModelRefSchema.parse(model)).toEqual(model);
    expect(ModelRefSchema.safeParse("chatgpt-5.5").success).toBe(false);

    for (const schema of [ThreadStartParamsSchema, TurnStartParamsSchema, ConfigSetParamsSchema]) {
      const base =
        schema === ThreadStartParamsSchema
          ? { cwd: "/tmp/work" }
          : schema === TurnStartParamsSchema
            ? { message: "hi" }
            : {};
      expect(schema.safeParse({ ...base, model }).success).toBe(true);
      expect(schema.safeParse({ ...base, model: "chatgpt-5.5" }).success).toBe(false);
    }
  });

  it("uses ModelRef for snapshots, model info, and assistant messages", () => {
    expect(
      ModelInfoSchema.safeParse({
        ...model,
        aliases: ["gpt-5.5-pro"],
        contextWindow: 300_000,
        maxOutputTokens: 128_000,
        supportsThinking: true,
      }).success,
    ).toBe(true);
    expect(
      AssistantMessageSchema.safeParse({
        role: "assistant",
        content: [],
        model,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
      }).success,
    ).toBe(true);
    expect(
      InitializeResponseSchema.safeParse({
        serverName: "diligent",
        serverVersion: "test",
        protocolVersion: 1,
        capabilities: { supportsFollowUp: true, supportsApprovals: true, supportsUserInput: true },
        currentModel: model,
      }).success,
    ).toBe(true);
  });
});
