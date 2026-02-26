export type { Command, CommandContext, AppAccessor } from "./types";
export { CommandRegistry } from "./registry";
export { parseCommand, isCommandPrefix, type ParsedCommand } from "./parser";
export { registerBuiltinCommands } from "./builtin/index";
