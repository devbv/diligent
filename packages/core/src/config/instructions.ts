import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const INSTRUCTION_FILES = ["CLAUDE.md"];
const MAX_INSTRUCTION_BYTES = 32_768; // 32 KiB

export interface DiscoveredInstruction {
  path: string;
  content: string;
}

/**
 * Walk from cwd upward, collecting CLAUDE.md files.
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
): string {
  const parts = [basePrompt];

  for (const inst of instructions) {
    parts.push(`\nInstructions from: ${inst.path}\n${inst.content}`);
  }

  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      parts.push(`\n${inst}`);
    }
  }

  return parts.join("\n");
}

const KNOWLEDGE_INSTRUCTION = `
You have access to an add_knowledge tool. Use it to save important information that should persist across sessions:
- Project patterns (naming conventions, preferred libraries, architectural patterns)
- User preferences (workflow, style, communication)
- Key decisions made during this session
- Corrections to previous behavior

Use your judgment — save knowledge when you discover something that would be useful in future sessions.`;

/**
 * Build system prompt with knowledge section and autonomous recording instruction.
 */
export function buildSystemPromptWithKnowledge(
  basePrompt: string,
  instructions: DiscoveredInstruction[],
  knowledgeSection: string,
  additionalInstructions?: string[],
): string {
  const parts = [basePrompt];

  if (knowledgeSection) {
    parts.push(knowledgeSection);
  }

  for (const inst of instructions) {
    parts.push(`\nInstructions from: ${inst.path}\n${inst.content}`);
  }

  if (additionalInstructions?.length) {
    for (const inst of additionalInstructions) {
      parts.push(`\n${inst}`);
    }
  }

  parts.push(KNOWLEDGE_INSTRUCTION);

  return parts.join("\n");
}
