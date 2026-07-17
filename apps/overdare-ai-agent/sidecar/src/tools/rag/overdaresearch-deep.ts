import type { ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { type RuntimeToolHost, requestToolApproval } from "@diligent/runtime";
import { z } from "zod";
import { buildOriginFileRender } from "./render";

const BASE_URL = "https://aiguide.overdare.com";
const TIMEOUT_MS = 5_000;

const LUA_BUCKET = "https://storage.googleapis.com/lua-script-bucket/";
const DOCS_BUCKET = "https://storage.googleapis.com/ovdr-docs-bucket/";

interface OriginFileResult {
  originFileUrl: string;
  content: string | null;
}

interface OriginFileResponse {
  files: OriginFileResult[];
  totalCount: number;
}

export const name = "overdaresearch_deep";

export const description = `Fetches original file contents and related metadata from OVERDARE after an initial overdaresearch.
Use this tool AFTER overdaresearch to get deeper context about specific files found in search results if you need.

one actions is available for now:

  - "origin-file": Fetch the full content of up to 10 original files by their GCS URLs.
    Use when you need the complete document content.
    Only URLs from lua-script-bucket or ovdr-docs-bucket are allowed.

When to use:
  - After overdaresearch returns results with fileUrl fields, use "origin-file" to fetch full file contents`;

export const parameters = z.object({
  action: z.enum(["origin-file"]).describe("origin-file = fetch full content of original files by GCS URL."),
  urls: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("For origin-file: 1-10 GCS file URLs (lua-script-bucket or ovdr-docs-bucket)."),
});

type Params = z.infer<typeof parameters>;

async function fetcher(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.substring(0, 200)}`);
  }
  return response.json();
}

function buildResult(action: string, requestedUrls: string[], files: unknown[], totalCount: number): ToolResult {
  const loaded = (files as { content: unknown }[]).filter((f) => f.content !== null);
  return {
    output: files.length
      ? JSON.stringify(files, null, 2)
      : `No ${action === "origin-file" ? "files returned" : "related metadata found"}.`,
    render: buildOriginFileRender(action, requestedUrls, files as OriginFileResult[]),
    metadata: { action, totalCount, loadedCount: loaded.length, files },
  };
}

async function originFile(urls: string[], signal: AbortSignal): Promise<ToolResult> {
  for (const url of urls) {
    if (!url.startsWith(LUA_BUCKET) && !url.startsWith(DOCS_BUCKET)) {
      throw new Error(`URL not from allowed bucket: ${url}\nAllowed: lua-script-bucket, ovdr-docs-bucket`);
    }
  }

  const params = urls.map((u) => `originFileUrl=${encodeURIComponent(u)}`).join("&");
  const data = (await fetcher(`${BASE_URL}/api/chat/rag/origin-file?${params}`, signal)) as OriginFileResponse;

  return buildResult("origin-file", urls, data.files ?? [], data.totalCount);
}

export async function execute(args: Params, _ctx: ToolContext, host?: RuntimeToolHost): Promise<ToolResult> {
  const approval = await requestToolApproval(host, {
    permission: "execute",
    toolName: name,
    description: `OVERDARE deep search [${args.action}]: ${args.urls.length} URL(s)`,
    details: { action: args.action, urls: args.urls },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await originFile(args.urls, controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OVERDARE deep search timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
