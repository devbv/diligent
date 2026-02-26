import { z } from "zod";
import { appendKnowledge } from "../knowledge/store";
import type { KnowledgeEntry, KnowledgeType } from "../knowledge/types";
import { generateEntryId } from "../session/types";
import type { Tool, ToolContext, ToolResult } from "../tool/types";

const addKnowledgeSchema = z.object({
  type: z.enum(["pattern", "decision", "discovery", "preference", "correction"]),
  content: z.string().describe("The knowledge to save. Be specific and actionable."),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  tags: z.array(z.string()).optional(),
});

export function createAddKnowledgeTool(knowledgePath: string, sessionId?: string): Tool<typeof addKnowledgeSchema> {
  return {
    name: "add_knowledge",
    description:
      "Save a piece of knowledge that should persist across sessions. " +
      "Use this for project patterns, user preferences, important decisions, " +
      "or corrections to previous behavior. Knowledge is injected into " +
      "future sessions automatically.",
    parameters: addKnowledgeSchema,
    execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const approval = await ctx.approve({
        permission: "write",
        toolName: "add_knowledge",
        description: `Save knowledge: [${args.type}] ${args.content.slice(0, 80)}`,
        details: { type: args.type },
      });
      if (approval === "reject") {
        return { output: "[Rejected by user]", metadata: { error: true } };
      }

      const entry: KnowledgeEntry = {
        id: generateEntryId(),
        timestamp: new Date().toISOString(),
        sessionId,
        type: args.type as KnowledgeType,
        content: args.content,
        confidence: args.confidence,
        tags: args.tags,
      };

      await appendKnowledge(knowledgePath, entry);

      return {
        output: `Knowledge saved: [${entry.type}] ${entry.content}`,
        metadata: { knowledgeId: entry.id },
      };
    },
  };
}
