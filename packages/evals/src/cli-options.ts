// @summary Parses eval suite and optional provider, task, model, seed, and report filters

import type { EvalProvider } from "./task";

export interface EvalCliOptions {
  suite: "core" | "runtime";
  provider?: EvalProvider;
  task?: string;
  model?: string;
  seed?: string;
  reportPath?: string;
  help: boolean;
}

export function parseCliOptions(args: string[]): EvalCliOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { suite: "core", help: true };
  }
  if (args[0] !== "core" && args[0] !== "runtime") {
    throw new Error(`Unknown eval suite "${args[0]}". Expected "core" or "runtime".`);
  }

  const options: EvalCliOptions = { suite: args[0], help: false };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--provider": {
        const value = requireValue(args, ++index, arg);
        if (value !== "openai" && value !== "anthropic" && value !== "gemini" && value !== "chatgpt") {
          throw new Error(`Invalid provider "${value}". Expected openai, anthropic, gemini, or chatgpt.`);
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

  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return value;
}
