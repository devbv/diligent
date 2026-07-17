// @summary Tests that convertMessages threads the OpenAI image `detail` setting (default "auto").
import { describe, expect, test } from "bun:test";
import { buildResponsesRequestBody, convertMessages } from "../../../../src/llm/provider/openai/responses";
import type { Message } from "../../../../src/types";

const imageBlock = {
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png" as const, data: "aGVsbG8=" },
};

// Pull the `detail` out of the first input_image content part, wherever it lands.
function firstImageDetail(items: unknown[]): string | undefined {
  for (const item of items as Array<{ content?: Array<{ type: string; detail?: string }> }>) {
    const part = item.content?.find((c) => c.type === "input_image");
    if (part) return part.detail;
  }
  return undefined;
}

describe("convertMessages image detail", () => {
  const userMsg: Message[] = [{ role: "user", content: [imageBlock], timestamp: 1 }];

  test("defaults to detail 'auto' for a user image", async () => {
    const items = await convertMessages(userMsg);
    expect(firstImageDetail(items)).toBe("auto");
  });

  test("uses the provided detail for a user image", async () => {
    const items = await convertMessages(userMsg, "low");
    expect(firstImageDetail(items)).toBe("low");
  });

  test("applies detail to tool_result output images too", async () => {
    const messages: Message[] = [
      {
        role: "tool_result",
        toolCallId: "tc_1",
        toolName: "image_tool",
        output: "see image",
        outputImages: [imageBlock],
        isError: false,
        timestamp: 1,
      },
    ];
    const items = await convertMessages(messages, "high");
    expect(firstImageDetail(items)).toBe("high");
  });

  test("buildResponsesRequestBody threads imageDetail into the request body", async () => {
    const body = await buildResponsesRequestBody({
      model: "gpt-5.5",
      messages: userMsg,
      imageDetail: "low",
    });
    expect(firstImageDetail(body.input as unknown[])).toBe("low");
  });

  test("replays encrypted reasoning only for the same provider", async () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "summary",
            providerState: {
              provider: "openai",
              itemId: "rs_1",
              encryptedContent: "opaque-reasoning",
            },
          },
          { type: "text", text: "answer" },
        ],
        model: "gpt-5.6-sol",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        timestamp: 1,
      },
    ];

    expect(await convertMessages(messages, "auto", undefined, "openai")).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "opaque-reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
      },
      { role: "assistant", content: "answer" },
    ]);
    expect(await convertMessages(messages, "auto", undefined, "chatgpt")).toEqual([
      { role: "assistant", content: "answer" },
    ]);
  });
});
