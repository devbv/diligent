import type { Command } from "./types";

export interface CompletionItem {
  name: string;
  description: string;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliases = new Map<string, string>();

  register(command: Command): this {
    if (this.commands.has(command.name)) {
      throw new Error(`Duplicate command: /${command.name}`);
    }
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliases.set(alias, command.name);
    }
    return this;
  }

  /** Look up by name or alias */
  get(name: string): Command | undefined {
    const resolved = this.aliases.get(name) ?? name;
    return this.commands.get(resolved);
  }

  /** All registered commands (for /help, autocomplete) */
  list(): Command[] {
    return [...this.commands.values()];
  }

  /** Autocomplete candidates for a partial name */
  complete(partial: string): string[] {
    const all = [...this.commands.keys(), ...this.aliases.keys()];
    return all.filter((n) => n.startsWith(partial)).sort();
  }

  /** Autocomplete candidates with descriptions for inline popup (primary names only) */
  completeDetailed(partial: string): CompletionItem[] {
    return [...this.commands.keys()]
      .filter((n) => n.startsWith(partial))
      .sort()
      .map((name) => {
        const cmd = this.commands.get(name);
        return { name, description: cmd?.description ?? "" };
      });
  }
}
