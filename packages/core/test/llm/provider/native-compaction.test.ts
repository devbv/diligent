// @summary Tests for provider-native compaction adapters (OpenAI/ChatGPT/Anthropic)
import { afterEach, describe, expect, mock, test } from "bun:test";
import { toSerializableError } from "../../../src/agent/util/errors";
import { createAnthropicNativeCompaction } from "../../../src/llm/provider/anthropic";
import { createChatGPTNativeCompaction } from "../../../src/llm/provider/chatgpt";
import { createOpenAINativeCompaction } from "../../../src/llm/provider/openai";
import { buildResponsesRequestBody, toResponseInputItems } from "../../../src/llm/provider/openai/responses";
import { describeCompactionPayload, extractCompactionSummaryItem } from "../../../src/llm/provider/openai/shared";
import type { Model } from "../../../src/llm/types";

const TEST_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6";

const originalFetch = globalThis.fetch;

function currentCompactionPayload(encryptedContent = "ENCRYPTED_COMPACTION_SUMMARY") {
  return { output: [{ type: "compaction", encrypted_content: encryptedContent }] };
}

const OPENAI_MODEL: Model = {
  id: "gpt-5.6-sol",
  provider: "openai",
  contextWindow: 200_000,
  maxOutputTokens: 16_000,
  supportsThinking: true,
};

const ANTHROPIC_MODEL: Model = {
  id: TEST_ANTHROPIC_MODEL_ID,
  provider: "anthropic",
  contextWindow: 300_000,
  maxOutputTokens: 16_000,
  supportsThinking: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("native compaction adapters", () => {
  test("OpenAI adapter posts to /responses/compact with auth header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const compact = createOpenAINativeCompaction("sk-openai", "https://api.openai.com/v1");
    const result = await compact({
      model: OPENAI_MODEL,
      systemPrompt: [{ label: "base", content: "You are helpful." }],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/responses/compact");
    expect(capturedHeaders.Authorization).toBe("Bearer sk-openai");
    expect(capturedBody.model).toBe("gpt-5.6-sol");
    expect(capturedBody.input).toBeArray();
    expect(result.status).toBe("ok");
  });

  test("OpenAI adapter prepends prior compactionSummary to compact input", async () => {
    let capturedBody: Record<string, unknown> = {};
    const message = {
      role: "user" as const,
      content: "follow up",
      timestamp: Date.now(),
    };
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const compact = createOpenAINativeCompaction("sk-openai", "https://api.openai.com/v1");
    await compact({
      model: OPENAI_MODEL,
      systemPrompt: [{ label: "base", content: "You are helpful." }],
      messages: [message],
      compactionSummary: {
        type: "compaction",
        encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
      },
    });

    expect(capturedBody.input).toEqual(
      await toResponseInputItems({
        messages: [message],
        compactionSummary: {
          type: "compaction",
          encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
        },
      }),
    );
  });

  test("OpenAI adapter materializes local images with the injected loader", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), { status: 200 });
    }) as unknown as typeof fetch;

    const compact = createOpenAINativeCompaction("sk-openai", "https://api.openai.com/v1");
    await compact({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [
        {
          role: "user",
          content: [{ type: "local_image", path: "image.png", mediaType: "image/png" }],
          timestamp: Date.now(),
        },
      ],
      localImageLoader: {
        load: async () => new TextEncoder().encode("image-bytes").buffer,
      },
    });

    expect(JSON.stringify(capturedBody.input)).toContain("data:image/png;base64,aW1hZ2UtYnl0ZXM=");
  });

  test("OpenAI adapter throws generic structured 400 errors with diagnostics", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Unknown parameter: 'store'.",
              type: "invalid_request_error",
              param: "store",
              code: "unknown_parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const compact = createOpenAINativeCompaction("sk-openai", "https://api.openai.com/v1");
    const error = await compact({
      model: OPENAI_MODEL,
      systemPrompt: [{ label: "base", content: "You are helpful." }],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OpenAI native compaction failed (400)");
    expect((error as Error).message).toContain("unknown_parameter");
    expect((error as Error).message).toContain("Unknown parameter: 'store'.");
    expect(toSerializableError(error).code).toBe("unknown_parameter");
  });

  test("OpenAI adapter throws an unstructured 400 instead of masking it as unsupported", async () => {
    globalThis.fetch = mock(
      async () => new Response("malformed compact request", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      createOpenAINativeCompaction("sk-openai")({
        model: OPENAI_MODEL,
        systemPrompt: [],
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
    ).rejects.toThrow("OpenAI native compaction failed (400) body=malformed compact request");
  });

  test.each([404, 405])("OpenAI adapter marks HTTP %d as unsupported", async (status) => {
    globalThis.fetch = mock(async () => new Response("not supported", { status })) as unknown as typeof fetch;

    const result = await createOpenAINativeCompaction("sk-openai")({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    expect(result).toEqual({ status: "unsupported", reason: `status_${status} body=not supported` });
  });

  test("compaction payload descriptor reports structured compaction items", () => {
    const payload = {
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
        {
          type: "compaction",
          encrypted_content: "encrypted",
        },
      ],
    };

    expect(describeCompactionPayload(payload)).toContain("structured_compaction_items=1");
    expect(extractCompactionSummaryItem(payload)).toEqual({
      type: "compaction",
      encrypted_content: "encrypted",
    });
  });

  test("rejects unobserved plaintext aliases with concise shape diagnostics", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ summary: "unproven plaintext alias" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await createOpenAINativeCompaction("sk-openai")({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    expect(result).toEqual({
      status: "unsupported",
      reason: "missing_summary payload_keys=summary output_items=0 output_shape=none structured_compaction_items=0",
    });
  });

  test("OpenAI adapter returns normalized compaction summary when present", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "compaction",
                encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const compact = createOpenAINativeCompaction("sk-openai", "https://api.openai.com/v1");
    const result = await compact({
      model: OPENAI_MODEL,
      systemPrompt: [{ label: "base", content: "You are helpful." }],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.compactionSummary).toEqual({
        type: "compaction",
        encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
      });
    }
  });

  test("request body prepends compaction summary before converted follow-up messages", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "follow up", timestamp: Date.now() }],
      compactionSummary: {
        type: "compaction",
        encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
      },
    });

    expect(body.input).toEqual([
      { type: "compaction", encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
  });

  test("ChatGPT adapter prepends prior compactionSummary to compact input", async () => {
    let capturedBody: Record<string, unknown> = {};
    const message = {
      role: "user" as const,
      content: "follow up",
      timestamp: Date.now(),
    };
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
    }));
    await adapter({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [message],
      compactionSummary: {
        type: "compaction",
        encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
      },
    });

    expect(capturedBody.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [] },
      ...(await toResponseInputItems({
        messages: [message],
        compactionSummary: {
          type: "compaction",
          encrypted_content: "ENCRYPTED_COMPACTION_SUMMARY",
        },
      })),
    ]);
  });

  test("ChatGPT adapter posts to codex compact endpoint with account header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
      account_id: "acct_1",
    }));
    const result = await adapter({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      sessionId: "session-1",
    });

    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(capturedHeaders.Authorization).toBe("Bearer access-token");
    expect(capturedHeaders["ChatGPT-Account-ID"]).toBe("acct_1");
    expect(capturedHeaders.version).toBe("0.144.1");
    expect(capturedHeaders["session-id"]).toBe("session-1");
    expect(capturedHeaders.session_id).toBeUndefined();
    expect(capturedBody.store).toBeUndefined();
    expect(result.status).toBe("ok");
  });

  test("ChatGPT adapter omits both session header spellings without a session ID", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify(currentCompactionPayload()), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
    }));

    await adapter({
      model: OPENAI_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    });

    expect(capturedHeaders["session-id"]).toBeUndefined();
    expect(capturedHeaders.session_id).toBeUndefined();
  });

  test("ChatGPT GPT-5.6 compaction uses the Responses Lite HTTP contract", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(currentCompactionPayload()), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
      account_id: "acct_1",
    }));

    await adapter({
      model: { ...OPENAI_MODEL, id: "chatgpt-5.6-luna", provider: "chatgpt" },
      systemPrompt: [{ label: "base", content: "System instructions" }],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      sessionId: "session-1",
    });

    expect(capturedHeaders["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(capturedBody.model).toBe("gpt-5.6-luna");
    expect(capturedBody.instructions).toBeUndefined();
    expect(capturedBody.tools).toBeUndefined();
    expect(capturedBody.parallel_tool_calls).toBe(false);
    expect((capturedBody.reasoning as { context: string }).context).toBe("all_turns");
    expect(capturedBody.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [] },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "System instructions" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  test("ChatGPT adapter treats 400 as error (not unsupported)", async () => {
    globalThis.fetch = mock(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
      account_id: "acct_1",
    }));

    await expect(
      adapter({
        model: OPENAI_MODEL,
        systemPrompt: [],
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      }),
    ).rejects.toThrow("ChatGPT native compaction failed (400) body=bad request");
  });

  test("ChatGPT adapter surfaces JSON error payload details", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "invalid_request", message: "session_id invalid" },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    const adapter = createChatGPTNativeCompaction(() => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      expires_at: Date.now() + 60_000,
      account_id: "acct_1",
    }));

    await expect(
      adapter({
        model: OPENAI_MODEL,
        systemPrompt: [],
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      }),
    ).rejects.toThrow("invalid_request | session_id invalid");
  });

  test("Anthropic adapter marks 404 as unsupported", async () => {
    globalThis.fetch = mock(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant");
    const result = await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    });

    expect(result.status).toBe("unsupported");
  });

  test("Anthropic adapter includes 400 error body in unsupported reason", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "max_tokens too small",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant");
    const result = await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [],
      messages: [
        {
          role: "user",
          content: "x".repeat(50_000 * 4),
          timestamp: Date.now(),
        },
      ],
    });

    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") {
      expect(result.reason).toContain("status_400");
      expect(result.reason).toContain("invalid_request_error");
      expect(result.reason).toContain("max_tokens too small");
    }
  });

  test("Anthropic adapter trims trailing assistant turns before native compaction request", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          stop_reason: "compaction",
          content: [{ type: "compaction", content: "opaque compacted context" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant", "https://api.anthropic.com");
    const result = await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [],
      messages: [
        {
          role: "user",
          content: "x".repeat(50_000 * 4),
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant reply" }],
          model: ANTHROPIC_MODEL.id,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      ],
    });

    expect(result.status).toBe("ok");
    expect(capturedBody.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "x".repeat(50_000 * 4),
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("Anthropic adapter sends an empty native-compaction conversation when no user message exists", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          stop_reason: "compaction",
          content: [{ type: "compaction", content: "opaque compacted context" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant", "https://api.anthropic.com");
    await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant-only history" }],
          model: ANTHROPIC_MODEL.id,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      ],
    });

    expect(capturedBody.messages).toEqual([]);
  });

  test("Anthropic adapter posts to /messages with beta compaction header and context_management", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          stop_reason: "compaction",
          content: [{ type: "compaction", content: "opaque compacted context" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant", "https://api.anthropic.com");
    const result = await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [{ label: "base", content: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: "x".repeat(50_000 * 4),
          timestamp: Date.now(),
        },
      ],
    });

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders["x-api-key"]).toBe("sk-ant");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(capturedHeaders["anthropic-beta"]).toBe("compact-2026-01-12");
    expect(capturedBody.model).toBe(TEST_ANTHROPIC_MODEL_ID);
    expect(capturedBody.max_tokens).toBe(4096);
    expect(capturedBody.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 50_000 },
          pause_after_compaction: true,
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.summary).toBe("opaque compacted context");
      expect(result.compactionSummary).toEqual({
        type: "compaction",
        content: "opaque compacted context",
      });
    }
  });

  test("Anthropic adapter prepends prior compactionSummary to native compaction request", async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          stop_reason: "compaction",
          content: [{ type: "compaction", content: "new compacted context" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = createAnthropicNativeCompaction("sk-ant", "https://api.anthropic.com");
    await adapter({
      model: ANTHROPIC_MODEL,
      systemPrompt: [],
      messages: [{ role: "user", content: "follow-up", timestamp: Date.now() }],
      compactionSummary: {
        type: "compaction",
        content: "prior compacted context",
      },
    });

    const messages = capturedBody.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "prior compacted context" }],
    });
    expect(messages[1]).toMatchObject({ role: "user" });
  });

  test("Anthropic message conversion reuses provider compactionSummary for follow-up requests", async () => {
    const { convertMessages } = await import("../../../src/llm/provider/anthropic");

    const converted = await convertMessages([{ role: "user", content: "follow-up", timestamp: Date.now() }], {
      type: "compaction",
      content: "opaque compacted context",
    });

    expect(converted).toHaveLength(2);
    expect(converted[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "opaque compacted context" }],
    });
    expect(converted[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "follow-up" }],
    });
  });
});
