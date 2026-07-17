// @summary Discovers and builds system prompts with AGENTS.md instructions and knowledge sections
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SystemSection } from "@diligent/core/provider-contract";

const INSTRUCTION_FILES = ["AGENTS.md"];
const MAX_INSTRUCTION_BYTES = 32_768; // 32 KiB

export interface DiscoveredInstruction {
  path: string;
  content: string;
}

/**
 * Walk from cwd upward, collecting AGENTS.md files.
 * Returns ordered from most specific (cwd) to most general.
 * Stops at filesystem root or .git boundary (project root).
 */
export async function discoverInstructions(cwd: string): Promise<DiscoveredInstruction[]> {
  const instructions: DiscoveredInstruction[] = [];
  let dir = cwd;

  while (true) {
    for (const filename of INSTRUCTION_FILES) {
      const filePath = join(dir, filename);
      const content = await readInstructionFile(filePath);
      if (content !== null) {
        instructions.push({ path: filePath, content });
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root

    // Stop at .git boundary (but only after checking current dir)
    if (dir !== cwd && existsSync(join(dir, ".git"))) break;

    dir = parent;
  }

  return instructions;
}

async function readInstructionFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const size = file.size;
    if (size > MAX_INSTRUCTION_BYTES) {
      const content = await file.text();
      return `${content.slice(0, MAX_INSTRUCTION_BYTES)}\n...(truncated)`;
    }
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * Build the full system prompt including discovered instructions.
 */
export function buildSystemPrompt(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  additionalInstructions?: string[],
): SystemSection[] {
  const sections: SystemSection[] = [{ label: "base", content: basePrompt }];

  for (const inst of instructions) {
    sections.push({
      tag: "user_instructions",
      tagAttributes: { path: inst.path },
      label: "instructions",
      content: inst.content,
      cacheControl: "ephemeral",
    });
  }

  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      sections.push({ label: "additional", content: inst });
    }
  }

  return sections;
}

const KNOWLEDGE_INSTRUCTION = `
You have access to search_knowledge and update_knowledge tools. Use search_knowledge to find existing knowledge entries by exact id, id_prefix, or query text before revising or deleting them, and use update_knowledge to save, revise, or delete durable user preferences that should persist across sessions. Knowledge ids may be stable caller-defined keys or generated UUIDs; use stable ids for recurring entries that should be updated in place.
Persist only user preferences, using type \`preference\`. Do not create knowledge entries for patterns, discoveries, corrections, or backlog items.
When the user says they want to do or build something, think carefully about whether it expresses a durable preference or is simply the work to do right now; in most cases it is immediate task intent, not knowledge.
Before your final response on a substantive task, do a brief wrap-up check: if this turn produced a durable user preference, update knowledge before replying.
Do not save transient current-turn intent or immediate implementation plans as knowledge.
Anti-pattern: storing “user wants to build X” right before implementing X in the same turn.`;

/**
 * Build system prompt with knowledge section, skills section, and autonomous recording instruction.
 */
export function buildSystemPromptWithKnowledge(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  knowledgeSection: string,
  additionalInstructions?: string[],
  skillsSection?: string,
  agentsSection?: string,
): SystemSection[] {
  const sections: SystemSection[] = [{ label: "base", content: basePrompt }];

  if (knowledgeSection) {
    sections.push({ tag: "knowledge", label: "knowledge", content: knowledgeSection, cacheControl: "ephemeral" });
  }

  if (skillsSection) {
    sections.push({ label: "skills", content: skillsSection });
  }

  if (agentsSection) {
    sections.push({ label: "agents", content: agentsSection });
  }

  for (const inst of instructions) {
    sections.push({
      tag: "user_instructions",
      tagAttributes: { path: inst.path },
      label: "instructions",
      content: inst.content,
      cacheControl: "ephemeral",
    });
  }

  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      sections.push({ label: "additional", content: inst });
    }
  }

  sections.push({ label: "knowledge_instruction", content: KNOWLEDGE_INSTRUCTION });

  return sections;
}
