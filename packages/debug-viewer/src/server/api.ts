// @summary REST API endpoint handlers for sessions, search, and knowledge queries

import { DEFAULT_ANTHROPIC_MODEL_ID, resolveModel } from "@diligent/core/llm/models";
import { createLogger, type Logger } from "@diligent/logging";
import { readdirSync } from "fs";
import { join } from "path";
import type {
  KnowledgeResponse,
  SearchResponse,
  SearchResult,
  SessionDataResponse,
  SessionListResponse,
  SessionTreeResponse,
  UsageSummaryResponse,
} from "../shared/protocol.js";
import type { AssistantMessageEntry, KnowledgeEntry, SessionEntry, UsageSummary } from "../shared/types.js";
import { buildTree, extractSessionMeta, parseSessionFile } from "./parser.js";

const apiLogger = createLogger({
  scope: "debug-viewer",
  context: { component: "server.api" },
});

function calculateUsageCost(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  modelId: string,
): number {
  let model = resolveModel(modelId);

  const hasAnyPricing =
    model.inputCostPer1M != null ||
    model.outputCostPer1M != null ||
    model.cacheReadCostPer1M != null ||
    model.cacheWriteCostPer1M != null;

  if (!hasAnyPricing) {
    if (modelId.startsWith("claude-sonnet-4-")) model = resolveModel(DEFAULT_ANTHROPIC_MODEL_ID);
    if (modelId.startsWith("claude-opus-4-")) model = resolveModel("claude-opus-4-8");
    if (modelId.startsWith("claude-haiku-4-")) model = resolveModel("claude-haiku-4-5-20251001");
  }

  const inputCost = (usage.inputTokens / 1_000_000) * (model.inputCostPer1M ?? 0);
  const outputCost = (usage.outputTokens / 1_000_000) * (model.outputCostPer1M ?? 0);
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * (model.cacheReadCostPer1M ?? 0);
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * (model.cacheWriteCostPer1M ?? 0);
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function createApiHandler(dataDir: string, logger: Logger = apiLogger) {
  const sessionsDir = join(dataDir, "sessions");
  const knowledgeDir = join(dataDir, "knowledge");

  async function listSessions(): Promise<SessionListResponse> {
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return { sessions: [] };
    }

    const sessions = await Promise.all(
      files.map(async (file) => {
        const filePath = join(sessionsDir, file);
        const entries = await parseSessionFile(filePath);
        return extractSessionMeta(filePath, entries);
      }),
    );

    // Sort by timestamp descending (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return { sessions };
  }

  async function getSession(id: string): Promise<SessionDataResponse | null> {
    const filePath = join(sessionsDir, `${id}.jsonl`);
    try {
      const entries = await parseSessionFile(filePath);
      return { id, entries };
    } catch {
      return null;
    }
  }

  async function getSessionTree(id: string): Promise<SessionTreeResponse | null> {
    const filePath = join(sessionsDir, `${id}.jsonl`);
    try {
      const entries = await parseSessionFile(filePath);
      const tree = buildTree(entries);
      return {
        id,
        tree: {
          entries: Object.fromEntries(tree.entries),
          children: Object.fromEntries(tree.children),
          roots: tree.roots,
        },
      };
    } catch {
      return null;
    }
  }

  async function getKnowledge(): Promise<KnowledgeResponse> {
    const filePath = join(knowledgeDir, "knowledge.jsonl");
    try {
      const file = Bun.file(filePath);
      const text = await file.text();
      const entries: KnowledgeEntry[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch (error) {
          logger.warn("knowledge_jsonl_line_parse_failed", {
            message: "Failed to parse knowledge JSONL line.",
            error,
            fields: { line: trimmed.slice(0, 80), filePath },
          });
        }
      }
      return { entries };
    } catch {
      return { entries: [] };
    }
  }

  async function getUsageSummary(): Promise<UsageSummaryResponse> {
    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      const emptySummary: UsageSummary = {
        sessionCount: 0,
        assistantMessageCount: 0,
        pricedMessageCount: 0,
        unpricedMessageCount: 0,
        totalCost: 0,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        modelBreakdown: [],
      };
      return { summary: emptySummary };
    }

    const summary: UsageSummary = {
      sessionCount: files.length,
      assistantMessageCount: 0,
      pricedMessageCount: 0,
      unpricedMessageCount: 0,
      totalCost: 0,
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      modelBreakdown: [],
    };

    const modelMap = new Map<
      string,
      {
        model: string;
        messageCount: number;
        pricedMessageCount: number;
        totalCost: number;
        totals: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          totalTokens: number;
        };
      }
    >();

    for (const file of files) {
      const filePath = join(sessionsDir, file);
      const entries = await parseSessionFile(filePath);
      for (const entry of entries) {
        if (!("role" in entry) || entry.role !== "assistant") continue;
        const assistant = entry as AssistantMessageEntry;

        summary.assistantMessageCount++;
        summary.totals.inputTokens += assistant.usage.inputTokens;
        summary.totals.outputTokens += assistant.usage.outputTokens;
        summary.totals.cacheReadTokens += assistant.usage.cacheReadTokens;
        summary.totals.cacheWriteTokens += assistant.usage.cacheWriteTokens;
        summary.totals.totalTokens += assistant.usage.inputTokens + assistant.usage.outputTokens;

        const item = modelMap.get(assistant.model) ?? {
          model: assistant.model,
          messageCount: 0,
          pricedMessageCount: 0,
          totalCost: 0,
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
          },
        };

        item.messageCount++;
        item.totals.inputTokens += assistant.usage.inputTokens;
        item.totals.outputTokens += assistant.usage.outputTokens;
        item.totals.cacheReadTokens += assistant.usage.cacheReadTokens;
        item.totals.cacheWriteTokens += assistant.usage.cacheWriteTokens;
        item.totals.totalTokens += assistant.usage.inputTokens + assistant.usage.outputTokens;

        const usageCost = calculateUsageCost(assistant.usage, assistant.model);
        if (usageCost > 0) {
          summary.pricedMessageCount++;
          item.pricedMessageCount++;
        } else {
          summary.unpricedMessageCount++;
        }
        summary.totalCost += usageCost;
        item.totalCost += usageCost;

        modelMap.set(assistant.model, item);
      }
    }

    summary.modelBreakdown = [...modelMap.values()].sort((a, b) => b.totalCost - a.totalCost);
    return { summary };
  }

  function searchEntries(entries: SessionEntry[], query: string): SearchResult[] {
    const results: SearchResult[] = [];
    const q = query.toLowerCase();

    for (const entry of entries) {
      const id = entry.id;

      if ("role" in entry && entry.role === "user") {
        const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
        const idx = content.toLowerCase().indexOf(q);
        if (idx >= 0) {
          results.push({
            sessionId: "",
            entryId: id,
            field: "content",
            snippet: content.slice(Math.max(0, idx - 40), idx + query.length + 40),
            matchIndex: idx,
          });
        }
      }

      if ("role" in entry && entry.role === "assistant") {
        for (const block of entry.content) {
          if (block.type === "text") {
            const idx = block.text.toLowerCase().indexOf(q);
            if (idx >= 0) {
              results.push({
                sessionId: "",
                entryId: id,
                field: "content.text",
                snippet: block.text.slice(Math.max(0, idx - 40), idx + query.length + 40),
                matchIndex: idx,
              });
            }
          }
          if (block.type === "tool_call") {
            const inputStr = JSON.stringify(block.input);
            const idx = inputStr.toLowerCase().indexOf(q);
            if (idx >= 0) {
              results.push({
                sessionId: "",
                entryId: id,
                field: `tool_call.${block.name}.input`,
                snippet: inputStr.slice(Math.max(0, idx - 40), idx + query.length + 40),
                matchIndex: idx,
              });
            }
          }
        }
      }

      if ("role" in entry && entry.role === "tool_result") {
        const idx = entry.output.toLowerCase().indexOf(q);
        if (idx >= 0) {
          results.push({
            sessionId: "",
            entryId: id,
            field: "output",
            snippet: entry.output.slice(Math.max(0, idx - 40), idx + query.length + 40),
            matchIndex: idx,
          });
        }
      }
    }

    return results;
  }

  async function search(query: string, sessionId?: string): Promise<SearchResponse> {
    const allResults: SearchResult[] = [];

    if (sessionId) {
      const data = await getSession(sessionId);
      if (data) {
        const results = searchEntries(data.entries, query);
        for (const r of results) r.sessionId = sessionId;
        allResults.push(...results);
      }
    } else {
      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return { query, results: [] };
      }

      for (const file of files) {
        const sid = file.replace(".jsonl", "");
        const filePath = join(sessionsDir, file);
        const entries = await parseSessionFile(filePath);
        const results = searchEntries(entries, query);
        for (const r of results) r.sessionId = sid;
        allResults.push(...results);
      }
    }

    return { query, results: allResults };
  }

  return async function handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/sessions" && req.method === "GET") {
      const data = await listSessions();
      return Response.json(data);
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const data = await getSession(sessionMatch[1]);
      if (!data) return new Response("Not found", { status: 404 });
      return Response.json(data);
    }

    const treeMatch = path.match(/^\/api\/sessions\/([^/]+)\/tree$/);
    if (treeMatch && req.method === "GET") {
      const data = await getSessionTree(treeMatch[1]);
      if (!data) return new Response("Not found", { status: 404 });
      return Response.json(data);
    }

    if (path === "/api/knowledge" && req.method === "GET") {
      const data = await getKnowledge();
      return Response.json(data);
    }

    if (path === "/api/usage/summary" && req.method === "GET") {
      const data = await getUsageSummary();
      return Response.json(data);
    }

    if (path === "/api/search" && req.method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) return new Response("Missing q parameter", { status: 400 });
      const sessionId = url.searchParams.get("session") ?? undefined;
      const data = await search(q, sessionId);
      return Response.json(data);
    }

    return null;
  };
}
