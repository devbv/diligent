// @summary Parses and validates canonical and investigation eval CLI options

import type { EvalProvider } from "./task";

export interface EvalCliOptions {
  suite: "core";
  canonical: boolean;
  provider?: EvalProvider;
  task?: string;
  model?: string;
  seed?: string;
  reportPath?: string;
  help: boolean;
}

export function parseCliOptions(args: string[]): EvalCliOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { suite: "core", canonical: false, help: true };
  }
  if (args[0] !== "core") {
    throw new Error(`Unknown eval suite "${args[0]}". Expected "core".`);
  }

  const options: EvalCliOptions = { suite: "core", canonical: false, help: false };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--canonical":
        options.canonical = true;
        break;
      case "--provider": {
        const value = requireValue(args, ++index, arg);
        if (value !== "openai" && value !== "anthropic") {
          throw new Error(`Invalid provider "${value}". Expected openai or anthropic.`);
        }
        options.provider = value;
        break;
      }
      case "--task":
        options.task = requireValue(args, ++index, arg);
        break;
      case "--model":
        options.model = requireValue(args, ++index, arg);
        break;
      case "--seed":
        options.seed = requireValue(args, ++index, arg);
        break;
      case "--report":
        options.reportPath = requireValue(args, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown eval option "${arg}".`);
    }
  }

  if (options.canonical && (options.provider || options.task || options.model)) {
    throw new Error("Canonical mode does not allow provider, task, or model overrides");
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return value;
}
