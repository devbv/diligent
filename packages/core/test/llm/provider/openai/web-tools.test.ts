// @summary Tests for OpenAI/ChatGPT provider-native web tool request and response normalization
import { describe, expect, test } from "bun:test";
import type { EventStream } from "../../../../src/event-stream";
import { buildResponsesRequestBody, type OpenAIResponsesTool } from "../../../../src/llm/provider/openai/responses";
import { handleResponsesAPIEvents } from "../../../../src/llm/provider/openai/sse";
import type { Model, ProviderEvent, ProviderResult, ToolDefinition } from "../../../../src/llm/types";

const OPENAI_MODEL: Model = {
  id: "gpt-5",
  provider: "openai",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
};

const CHATGPT_MODEL: Model = {
  id: "chatgpt-5",
  provider: "chatgpt",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsThinking: true,
};

describe("OpenAI native web tools", () => {
  test("request body includes function tools alongside merged web search tool", async () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: {
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
      {
        kind: "provider_builtin",
        capability: "web",
        options: {
          allowedDomains: ["example.com"],
          userLocation: { type: "approximate", country: "US" },
          maxContentTokens: 10_000,
        },
      },
    ];

    const body = await buildResponsesRequestBody({
      model: OPENAI_MODEL.id,
      messages: [{ role: "user", content: "Find it", timestamp: 1 }],
      tools,
      strictTools: false,
      useReasoning: true,
      effort: "medium",
    });

    expect(body.include).toEqual(
      expect.arrayContaining(["reasoning.encrypted_content", "web_search_call.action.sources"]),
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
          additionalProperties: false,
        },
        strict: false,
      },
      {
        type: "web_search",
        filters: { allowed_domains: ["example.com"] },
        search_context_size: "high",
        user_location: { type: "approximate", country: "US" },
      } satisfies OpenAIResponsesTool,
    ]);
  });

  test("request body omits web tool declarations and source includes when no provider web tools are present", async () => {
    const tools: ToolDefinition[] = [
      {
        kind: "function",
        name: "read",
        description: "Read a file",
        inputSchema: {
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    ];

    const body = await buildResponsesRequestBody({
      model: OPENAI_MODEL.id,
      messages: [{ role: "user", content: "Find it", timestamp: 1 }],
      tools,
      strictTools: false,
      useReasoning: true,
      effort: "medium",
    });

    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
          additionalProperties: false,
        },
        strict: false,
      },
    ]);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("response parser normalizes web search calls, results, and citations", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.added",
        item: {
          type: "web_search_call",
          call_id: "ws_1",
          action: { type: "search", query: "diligent" },
        },
      };
      yield {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          call_id: "ws_1",
          action: {
            type: "search",
            query: "diligent",
            sources: [
              {
                url: "https://example.com",
                title: "Example",
                snippet: "Result snippet",
                encrypted_content: "enc1",
              },
            ],
          },
        },
      };
      yield {
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Found it.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com",
                  title: "Example",
                  start_index: 0,
                  end_index: 5,
                },
              ],
            },
          ],
        },
      };
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 3, output_tokens: 4 } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, OPENAI_MODEL);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content_block",
          block: expect.objectContaining({ type: "provider_tool_use", id: "ws_1" }),
        }),
        expect.objectContaining({
          type: "content_block",
          block: expect.objectContaining({ type: "web_search_result", toolUseId: "ws_1" }),
        }),
      ]),
    );

    const done = events.find((event): event is Extract<ProviderEvent, { type: "done" }> => event.type === "done");
    expect(done).toBeDefined();
    expect(done?.message.content).toEqual([
      {
        type: "provider_tool_use",
        id: "ws_1",
        provider: "openai",
        name: "web_search",
        input: { type: "search", query: "diligent" },
      },
      {
        type: "web_search_result",
        toolUseId: "ws_1",
        provider: "openai",
        results: [
          {
            url: "https://example.com",
            title: "Example",
            snippet: "Result snippet",
            encryptedContent: "enc1",
          },
        ],
      },
      {
        type: "text",
        text: "Found it.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Example",
            citedText: "Found",
          },
        ],
      },
    ]);
  });

  test("response parser emits generic provider_tool_use placeholder when web search start lacks action payload", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.added",
        item: {
          id: "ws_placeholder_1",
          type: "web_search_call",
          status: "in_progress",
        },
      };
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, CHATGPT_MODEL);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content_block",
          block: expect.objectContaining({
            type: "provider_tool_use",
            id: "ws_placeholder_1",
            name: "web_search",
            input: { type: "search" },
          }),
        }),
      ]),
    );
  });

  test("response parser normalizes fetch-style open_page for ChatGPT", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.added",
        item: {
          type: "web_search_call",
          call_id: "wf_1",
          action: { type: "open_page", url: "https://example.com/page" },
        },
      };
      yield {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          call_id: "wf_1",
          action: { type: "open_page", url: "https://example.com/page" },
          document: {
            mime_type: "text/html",
            title: "Fetched Page",
            text: "Page body",
          },
          retrieved_at: "2026-04-05T00:00:00Z",
        },
      };
      yield {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 2, output_tokens: 2 } },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, CHATGPT_MODEL);

    const done = events.find((event): event is Extract<ProviderEvent, { type: "done" }> => event.type === "done");
    expect(done?.message.content).toEqual([
      {
        type: "provider_tool_use",
        id: "wf_1",
        provider: "chatgpt",
        name: "web_fetch",
        input: { type: "open_page", url: "https://example.com/page" },
      },
      {
        type: "web_fetch_result",
        toolUseId: "wf_1",
        provider: "chatgpt",
        url: "https://example.com/page",
      },
    ]);
  });

  test("response parser falls back to response.completed output when web search results are absent from output_item.done", async () => {
    const events: ProviderEvent[] = [];
    const stream = {
      push(event: ProviderEvent) {
        events.push(event);
      },
    } as unknown as EventStream<ProviderEvent, ProviderResult>;

    async function* iter(): AsyncIterable<Record<string, unknown>> {
      yield {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          call_id: "ws_completed_1",
          action: { type: "search" },
        },
      };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 6 },
          output: [
            {
              type: "web_search_call",
              call_id: "ws_completed_1",
              action: {
                type: "search",
                query: "roblox stock",
                sources: [
                  {
                    url: "https://finance.example.com/rblx",
                    title: "RBLX Quote",
                    snippet: "Roblox stock rose today.",
                  },
                ],
              },
            },
          ],
        },
      };
    }

    await handleResponsesAPIEvents(iter(), stream, CHATGPT_MODEL);

    const done = events.find((event): event is Extract<ProviderEvent, { type: "done" }> => event.type === "done");
    expect(done?.message.content).toEqual([
      {
        type: "provider_tool_use",
        id: "ws_completed_1",
        provider: "chatgpt",
        name: "web_search",
        input: { type: "search" },
      },
      {
        type: "web_search_result",
        toolUseId: "ws_completed_1",
        provider: "chatgpt",
        results: [
          {
            url: "https://finance.example.com/rblx",
            title: "RBLX Quote",
            snippet: "Roblox stock rose today.",
          },
        ],
      },
    ]);
  });
});
