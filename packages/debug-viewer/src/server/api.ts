import { readdirSync } from "fs";
import { join } from "path";
import type {
  KnowledgeResponse,
  SearchResponse,
  SearchResult,
  SessionDataResponse,
  SessionListResponse,
  SessionTreeResponse,
} from "../shared/protocol.js";
import type { KnowledgeEntry, SessionEntry } from "../shared/types.js";
import { buildTree, extractSessionMeta, parseSessionFile } from "./parser.js";

export function createApiHandler(dataDir: string) {
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
        } catch {
          // skip malformed
        }
      }
      return { entries };
    } catch {
      return { entries: [] };
    }
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
