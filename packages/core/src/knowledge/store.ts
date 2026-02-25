import { join } from "node:path";
import type { KnowledgeEntry } from "./types";

const KNOWLEDGE_FILENAME = "knowledge.jsonl";

/** Append a knowledge entry to the store. */
export async function appendKnowledge(knowledgePath: string, entry: KnowledgeEntry): Promise<void> {
  const filePath = join(knowledgePath, KNOWLEDGE_FILENAME);
  const line = `${JSON.stringify(entry)}\n`;

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const existing = await file.text();
    await Bun.write(filePath, existing + line);
  } else {
    await Bun.write(filePath, line);
  }
}

/** Read all knowledge entries from the store. */
export async function readKnowledge(knowledgePath: string): Promise<KnowledgeEntry[]> {
  const filePath = join(knowledgePath, KNOWLEDGE_FILENAME);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];

  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as KnowledgeEntry);
}
