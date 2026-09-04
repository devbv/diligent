// @summary Generates one GUI image through local Codex OAuth, imports it into Studio, and returns the created asset ID.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { ImageBlock } from "@diligent/protocol";
import { resolvePaths } from "@diligent/runtime";
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";

const TOOL_NAME = "studiorpc_generate_image_asset";
const IMAGE_TIMEOUT_MS = 300_000;

const parameters = z
  .object({
    prompt: z.string().trim().min(1).max(6_000).describe("Image-generation prompt for one GUI asset."),
  })
  .strict();

type JsonRecord = Record<string, unknown>;

export type GenerateCodexImage = (input: { cwd: string; prompt: string; signal?: AbortSignal }) => Promise<{
  sourcePath: string;
  revisedPrompt?: string;
}>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isManagedChatGptOAuth(result: unknown): boolean {
  return isRecord(result) && isRecord(result.account) && result.account.type === "chatgpt";
}

function imageArtifact(item: unknown): { sourcePath: string; revisedPrompt?: string } | undefined {
  if (!isRecord(item) || item.type !== "imageGeneration") return undefined;
  const sourcePath = stringValue(item.savedPath);
  if (!sourcePath || !isAbsolute(sourcePath)) return undefined;
  const revisedPrompt = stringValue(item.revisedPrompt);
  return { sourcePath, ...(revisedPrompt ? { revisedPrompt } : {}) };
}

async function withCodexAppServer<T>(
  cwd: string,
  signal: AbortSignal | undefined,
  run: (input: {
    request(method: string, params: JsonRecord): Promise<unknown>;
    waitForImage(threadId: string): Promise<{ sourcePath: string; revisedPrompt?: string }>;
  }) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const executable = process.env.DILIGENT_CODEX_BIN?.trim() || "codex";
  const child = spawn(executable, ["app-server"], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, PendingRequest>();
  let requestId = 1;
  let closed = false;
  let imageWaiter:
    | {
        threadId: string;
        resolve(value: { sourcePath: string; revisedPrompt?: string }): void;
        reject(error: Error): void;
      }
    | undefined;

  const finish = (error: Error) => {
    if (closed) return;
    closed = true;
    lines.close();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    imageWaiter?.reject(error);
    imageWaiter = undefined;
    child.kill("SIGTERM");
  };

  const onAbort = () =>
    finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });

  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        const detail =
          isRecord(message.error) && typeof message.error.message === "string"
            ? message.error.message
            : "request failed";
        request.reject(new Error(`Codex App Server ${detail}`));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.method === "item/completed" && isRecord(message.params) && imageWaiter) {
      const params = message.params;
      if (params.threadId !== imageWaiter.threadId) return;
      const image = imageArtifact(params.item);
      if (!image) return;
      const waiter = imageWaiter;
      imageWaiter = undefined;
      waiter.resolve(image);
    }

    if (message.method === "turn/completed" && isRecord(message.params) && imageWaiter) {
      const params = message.params;
      if (params.threadId !== imageWaiter.threadId) return;
      queueMicrotask(() => {
        if (!imageWaiter) return;
        const waiter = imageWaiter;
        imageWaiter = undefined;
        waiter.reject(new Error("Codex completed the turn without producing a saved image."));
      });
    }
  });
  child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  child.on("exit", (code) => {
    if (!closed)
      finish(new Error(`Codex App Server exited before image generation completed (code ${code ?? "unknown"}).`));
  });

  const request = (method: string, params: JsonRecord): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !child.stdin.writable) {
        reject(new Error("Codex App Server is not available."));
        return;
      }
      const id = requestId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const waitForImage = (threadId: string): Promise<{ sourcePath: string; revisedPrompt?: string }> =>
    new Promise((resolve, reject) => {
      if (imageWaiter) {
        reject(new Error("Codex image generation is already running."));
        return;
      }
      const timer = setTimeout(() => {
        if (!imageWaiter) return;
        imageWaiter = undefined;
        reject(new Error(`Codex image generation timed out after ${IMAGE_TIMEOUT_MS}ms.`));
      }, IMAGE_TIMEOUT_MS);
      imageWaiter = {
        threadId,
        resolve: (image) => {
          clearTimeout(timer);
          resolve(image);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

  try {
    await request("initialize", {
      clientInfo: { name: "overdare-image-generation", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return await run({ request, waitForImage });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    finish(new Error("Codex App Server session closed."));
  }
}

const generateWithCodex: GenerateCodexImage = async (input) => {
  return withCodexAppServer(input.cwd, input.signal, async ({ request, waitForImage }) => {
    const account = await request("account/read", { refreshToken: false });
    if (!isManagedChatGptOAuth(account)) {
      throw new Error("Codex image generation requires a managed ChatGPT OAuth account, not an API key.");
    }
    const capabilities = await request("modelProvider/capabilities/read", {});
    if (!isRecord(capabilities) || capabilities.imageGeneration !== true) {
      throw new Error("The connected Codex account does not support image generation.");
    }
    const thread = await request("thread/start", {
      cwd: input.cwd,
      ephemeral: true,
      developerInstructions:
        "Generate exactly one requested image asset with the built-in image generation skill. Do not edit project files or run unrelated tools.",
    });
    const threadId = isRecord(thread) && isRecord(thread.thread) ? stringValue(thread.thread.id) : undefined;
    if (!threadId) throw new Error("Codex App Server did not return a thread ID.");

    const image = waitForImage(threadId);
    await request("turn/start", {
      threadId,
      cwd: input.cwd,
      input: [{ type: "text", text: `$imagegen\n${input.prompt}` }],
    });
    return image;
  });
};

function mediaTypeFor(path: string): ImageBlock["source"]["media_type"] {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    default:
      throw new Error("Codex image generation returned an unsupported image format.");
  }
}

function readAssetId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.asset)) return undefined;
  return stringValue(result.asset.assetid);
}

async function copyGeneratedImage(cwd: string, sourcePath: string) {
  const mediaType = mediaTypeFor(sourcePath);
  const directory = join(resolvePaths(cwd).images, "generated");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `generated-${randomUUID()}${extname(sourcePath).toLowerCase()}`);
  await copyFile(sourcePath, file);
  return { file, mediaType, bytes: await readFile(file) };
}

export function createGenerateImageAssetTool(input: {
  cwd: string;
  callRpc: typeof call;
  writeLock: WriteLock;
  generateCodexImage?: GenerateCodexImage;
}): Tool {
  const generateCodexImage = input.generateCodexImage ?? generateWithCodex;

  return {
    name: TOOL_NAME,
    description:
      "Generate one custom GUI image with the signed-in Codex ChatGPT OAuth account, import it into the Studio asset manager, and return the generated assetId plus an image preview.",
    parameters,
    supportParallel: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parameters.parse(args);
      const approval = await ctx.approve({
        permission: "execute",
        toolName: TOOL_NAME,
        description: "Generate a Codex OAuth image and import it into Studio",
        details: { source: "Codex managed ChatGPT OAuth", prompt: parsed.prompt },
      });
      if (approval === "reject") {
        return { output: "[Rejected by user]", metadata: { error: true, operation: "image_generation" } };
      }

      const image = await generateCodexImage({ cwd: input.cwd, prompt: parsed.prompt, signal: ctx.signal });
      const saved = await copyGeneratedImage(input.cwd, image.sourcePath);
      const release = await input.writeLock.acquire();
      try {
        const imported = await input.callRpc(
          "asset_manager.image.import",
          { file: saved.file },
          { signal: ctx.signal },
        );
        const assetId = readAssetId(imported);
        if (!assetId) throw new Error("Studio imported the generated image but did not return an asset ID.");
        await input.callRpc("level.save.file", {}, { signal: ctx.signal });
        return {
          output: JSON.stringify(
            {
              assetId,
              file: saved.file,
              source: "codex-oauth",
              ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
            },
            null,
            2,
          ),
          outputImages: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: saved.mediaType,
                data: saved.bytes.toString("base64"),
              },
            },
          ],
          metadata: { operation: "image_generation", assetId, file: saved.file, source: "codex-oauth" },
        };
      } finally {
        release();
      }
    },
  };
}
