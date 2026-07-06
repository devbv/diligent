// @summary Knowledge CRUD request handlers extracted from thread-handlers.ts

import { readKnowledge, writeKnowledge } from "../knowledge/store";
import type { KnowledgeEntry, KnowledgeType } from "../protocol/index";
import type { ThreadHandlersContext } from "./handler-context";

export async function handleKnowledgeList(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  limit?: number,
): Promise<{ data: unknown[] }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const paths = await ctx.resolvePaths(runtime.cwd);
  const entries = await readKnowledge(paths.knowledge);
  return { data: entries.slice(0, limit ?? entries.length) };
}

export async function handleKnowledgeUpdate(
  ctx: ThreadHandlersContext,
  threadId: string | undefined,
  params: {
    action: "upsert" | "delete";
    id?: string;
    type?: KnowledgeType;
    content?: string;
    tags?: string[];
  },
): Promise<{ entry?: KnowledgeEntry; deleted?: boolean }> {
  const runtime = await ctx.resolveThreadRuntime(threadId);
  const paths = await ctx.resolvePaths(runtime.cwd);
  const entries = await readKnowledge(paths.knowledge);

  if (params.action === "delete") {
    if (!params.id) {
      throw Object.assign(new Error("Knowledge id is required for delete action"), { code: -32602 });
    }
    const nextEntries = entries.filter((entry) => entry.id !== params.id);
    const deleted = nextEntries.length !== entries.length;
    if (deleted) {
      await writeKnowledge(paths.knowledge, nextEntries);
    }
    return { deleted };
  }

  if (!params.type || !params.content || params.content.trim().length === 0) {
    throw Object.assign(new Error("Knowledge type and content are required for upsert action"), { code: -32602 });
  }

  const now = new Date().toISOString();
  const requestedContent = params.content.trim();

  if (params.id) {
    const index = entries.findIndex((entry) => entry.id === params.id);
    if (index >= 0) {
      const updated: KnowledgeEntry = {
        ...entries[index],
        type: params.type,
        content: requestedContent,
        tags: params.tags ?? entries[index].tags,
        timestamp: now,
      };
      entries[index] = updated;
      await writeKnowledge(paths.knowledge, entries);
      return { entry: updated };
    }
  }

  const entry: KnowledgeEntry = {
    id: crypto.randomUUID(),
    timestamp: now,
    sessionId: runtime.id,
    type: params.type,
    content: requestedContent,
    confidence: 0.8,
    tags: params.tags,
  };
  entries.push(entry);
  await writeKnowledge(paths.knowledge, entries);
  return { entry };
}
