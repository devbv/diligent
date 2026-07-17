// @summary E2E tests for read_image across providers. Each provider receives the image and the model
// must answer with the correct color. Pre-fix, OpenAI/Gemini silently dropped outputImages and the
// model would hallucinate or refuse. Gated on DILIGENT_RUN_LIVE_E2E=1 and the respective API key.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { AgentOptions, CoreAgentEvent, Message, StreamFunction, SystemSection, Tool } from "@diligent/runtime";
import {
  Agent,
  createAnthropicStream,
  createGeminiStream,
  createOpenAIStream,
  createReadImageTool,
  resolveModel,
} from "@diligent/runtime";

type StreamFn = NonNullable<AgentOptions["llmMsgStreamFn"]> | StreamFunction;

const runLiveE2E = process.env.DILIGENT_RUN_LIVE_E2E === "1";

// --- valid PNG builder (no native deps) ---
function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeSolidColorPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = r;
      row[1 + x * 3 + 1] = g;
      row[1 + x * 3 + 2] = b;
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SYSTEM_PROMPT: SystemSection[] = [
  {
    label: "test",
    content:
      "You are a precise assistant. When asked about an image, use the read_image tool and then answer with one short sentence naming the dominant color.",
  },
];

async function runAgent(agent: Agent, prompt: string): Promise<{ events: CoreAgentEvent[]; messages: Message[] }> {
  const events: CoreAgentEvent[] = [];
  const unsub = agent.subscribe((e) => events.push(e));
  try {
    const messages = await agent.prompt({ role: "user", content: prompt, timestamp: Date.now() });
    return { events, messages };
  } finally {
    unsub();
  }
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      return m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
  }
  return "";
}

interface ProviderCase {
  name: string;
  envKey: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY";
  modelId: string;
  makeStream: (apiKey: string) => StreamFn;
}

const PROVIDERS: ProviderCase[] = [
  {
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    modelId: "claude-haiku-4-5-20251001",
    makeStream: (apiKey) => createAnthropicStream(apiKey) as never,
  },
  {
    name: "OpenAI Responses (gpt-5.6-terra)",
    envKey: "OPENAI_API_KEY",
    modelId: "gpt-5.6-terra",
    makeStream: (apiKey) => createOpenAIStream(apiKey) as never,
  },
  {
    name: "Gemini (3.5-flash)",
    envKey: "GEMINI_API_KEY",
    modelId: "gemini-3.5-flash",
    makeStream: (apiKey) => createGeminiStream(apiKey) as never,
  },
];

describe("E2E: read_image cross-provider parity", () => {
  if (!runLiveE2E) {
    test.skip("Set DILIGENT_RUN_LIVE_E2E=1 plus at least one provider key to run live E2E", () => {});
    return;
  }

  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.envKey];

    describe(provider.name, () => {
      if (!apiKey) {
        test.skip(`Set ${provider.envKey} to run`, () => {});
        return;
      }

      test("model sees red image and reports red", async () => {
        const dir = mkdtempSync(join(tmpdir(), "diligent-e2e-readimg-"));
        const file = join(dir, "red.png");
        writeFileSync(file, makeSolidColorPng(128, 128, 220, 30, 30));
        try {
          const model = resolveModel(provider.modelId);
          const agent = new Agent(model, SYSTEM_PROMPT, [createReadImageTool()] as Tool[], {
            llmMsgStreamFn: provider.makeStream(apiKey) as never,
          });
          const { events, messages } = await runAgent(
            agent,
            `Use read_image on ${file} and answer with one short sentence stating the dominant color.`,
          );

          const toolEnd = events.find(
            (e): e is Extract<CoreAgentEvent, { type: "tool_end" }> =>
              e.type === "tool_end" && e.toolName === "read_image",
          );
          expect(toolEnd).toBeDefined();
          // outputImages must flow through the agent event (this is the contract other providers now respect)
          expect(toolEnd?.outputImages?.length ?? 0).toBeGreaterThan(0);

          const reply = lastAssistantText(messages).toLowerCase();
          expect(reply).toMatch(/\bred\b/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 90_000);

      test("model sees blue image and reports blue (sanity check vs hallucination)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "diligent-e2e-readimg-"));
        const file = join(dir, "blue.png");
        writeFileSync(file, makeSolidColorPng(128, 128, 30, 30, 220));
        try {
          const model = resolveModel(provider.modelId);
          const agent = new Agent(model, SYSTEM_PROMPT, [createReadImageTool()] as Tool[], {
            llmMsgStreamFn: provider.makeStream(apiKey) as never,
          });
          const { messages } = await runAgent(
            agent,
            `Use read_image on ${file} and answer with one short sentence stating the dominant color.`,
          );
          const reply = lastAssistantText(messages).toLowerCase();
          // If the model hallucinated (image was dropped), it would not consistently pick the right color.
          expect(reply).toMatch(/\bblue\b/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 90_000);
    });
  }
});
