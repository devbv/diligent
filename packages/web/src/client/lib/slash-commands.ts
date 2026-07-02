// @summary Slash command definitions, parser, and filter logic for web UI autocomplete

export interface SlashCommand {
  name: string;
  description: string;
  /** Usage string shown when args are required */
  usage?: string;
  /** Whether this command requires a string argument */
  requiresArgs?: boolean;
  /** Whether this is a dynamically registered skill command */
  isSkill?: boolean;
}

const DEFAULT_EFFORT_USAGE = "minimal|low|medium|high|max";

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
  },
  {
    name: "new",
    description: "Start a new session",
  },
  {
    name: "resume",
    description: "Resume thread",
    usage: "/resume <thread-id>",
    requiresArgs: true,
  },
  {
    name: "model",
    description: "Switch model",
    usage: "/model <model-id>",
    requiresArgs: true,
  },
  {
    name: "effort",
    description: "Set thinking level",
    usage: `/effort <${DEFAULT_EFFORT_USAGE}>`,
    requiresArgs: true,
  },
  {
    name: "mcp",
    description: "List and manage MCP servers",
    usage: "/mcp list | login <server> | logout <server>",
  },
  {
    name: "reload",
    description: "Reload config, skills, agents, tools & MCP servers",
  },
];

/** Build the full command list by merging builtins with dynamic skill commands. */
export function buildCommandList(skills: Array<{ name: string; description: string }>): SlashCommand[] {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const skillCommands: SlashCommand[] = skills
    .filter((s) => !builtinNames.has(s.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      isSkill: true,
    }));
  return [...BUILTIN_COMMANDS, ...skillCommands];
}

export interface ParsedSlashCommand {
  name: string;
  args: string | undefined;
}

/** Returns null if not a slash command (doesn't start with / or starts with //) */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { name: trimmed.slice(1), args: undefined };
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim() || undefined,
  };
}

/** Filter commands by partial name (after the /) */
export function filterCommands(commands: SlashCommand[], partial: string): SlashCommand[] {
  const lower = partial.toLowerCase();
  return commands.filter((cmd) => cmd.name.startsWith(lower));
}

/** Check if input is a slash command prefix (for triggering autocomplete) */
export function isSlashPrefix(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//") && !text.includes(" ");
}
