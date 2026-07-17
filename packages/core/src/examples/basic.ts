// @summary Minimal example: create an Agent with a tool and run it with a user message
import { z } from "zod";
import { Agent } from "../agent/agent";
import type { Tool } from "../tool/types";
import type { Message } from "../types";
import { c, tag } from "./common/colors";

const I1 = "  ";
const I2 = "    ";
const DEFAULT_MODEL = "claude-sonnet-4-6";

const calculatorTool: Tool<z.ZodObject<{ expression: z.ZodString }>> = {
  name: "calculator",
  description: "Evaluate a simple arithmetic expression and return the result.",
  parameters: z.object({
    expression: z.string().describe("A math expression, e.g. '2 + 3 * 4'"),
  }),
  execute: async ({ expression }) => {
    try {
      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${expression})`)() as number;
      return { output: String(result) };
    } catch {
      return { output: `Error: could not evaluate "${expression}"` };
    }
  },
};

const agent = new Agent(
  DEFAULT_MODEL,
  [{ label: "system", content: "You are a helpful assistant. Use the calculator tool when asked to compute math." }],
  [calculatorTool],
);

let turnCount = 0;
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log(tag(c.green, "agent_start"));
      break;
    case "turn_start":
      console.log(`${I1}${tag(c.cyan, "turn_start")} ${c.dim}turn #${++turnCount}${c.reset}`);
      break;
    case "turn_end":
      console.log(`${I1}${tag(c.cyan, "turn_end")} ${c.dim}turn #${turnCount}${c.reset}`);
      break;
    case "message_start":
      process.stdout.write(I2);
      break;
    case "message_delta":
      if (event.delta.type === "text_delta") process.stdout.write(event.delta.delta.replace(/\n/g, `\n${I2}`));
      break;
    case "message_end":
      process.stdout.write("\n");
      break;
    case "tool_start":
      console.log(
        `${I2}${tag(c.yellow, "tool_start")} ${c.bold}${event.toolName}${c.reset}${c.gray}(${JSON.stringify(event.input)})${c.reset}`,
      );
      break;
    case "tool_end":
      console.log(
        `${I2}${tag(c.yellow, "tool_end")} ${c.bold}${event.toolName}${c.reset} → ${c.magenta}${event.output}${c.reset}`,
      );
      break;
    case "usage":
      console.log(
        `${I2}${tag(c.gray, "usage")} ${c.dim}in=${event.usage.inputTokens} out=${event.usage.outputTokens}${c.reset}`,
      );
      break;
    case "agent_end":
      console.log(tag(c.green, "agent_end"));
      break;
    case "error":
      console.error(`${I2}${tag(c.red, "error")} ${event.error.message}`);
      break;
  }
});

const userInput = process.argv[2] ?? "What is (123 * 456) + 789?";

const userMessage: Message = { role: "user", content: [{ type: "text", text: userInput }], timestamp: Date.now() };

agent
  .prompt(userMessage)
  .then((result) => {
    console.log("\nFinal message count:", result.length);
  })
  .catch((err: unknown) => {
    console.error("Agent failed:", err);
    process.exit(1);
  });
