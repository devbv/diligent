// @summary Core eval task for exact streamed direct responses without tools

import type { EvalTask } from "../../task";
import { fixtureToken, getFinalText, getTextDeltas } from "./helpers";

export interface DirectResponseWorld {
  nonce: string;
}

export const directResponseTask: EvalTask<DirectResponseWorld> = {
  id: "direct-response",
  description: "Streams one exact nonce without advertising tools.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Follow the user's response-format instruction exactly. Do not add explanation, punctuation, or formatting.",
    },
  ],
  limits: { maxTurns: 1, maxToolCalls: 0, timeoutMs: 90_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({ nonce: fixtureToken(seed, "direct-response-nonce", "EVAL") }),
  createTools: () => [],
  createUserMessage: (world) => ({
    role: "user",
    content: `Return exactly this nonce and nothing else:\n${world.nonce}`,
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({ nonce: world.nonce }),
  evaluate: (execution) => {
    const finalText = getFinalText(execution);
    if (finalText !== execution.world.nonce) {
      return {
        passed: false,
        code: "direct_response.final_text_mismatch",
        message: `Final text did not equal the expected nonce ${execution.world.nonce}.`,
      };
    }
    const streamedText = getTextDeltas(execution);
    if (streamedText !== execution.world.nonce) {
      return {
        passed: false,
        code: "direct_response.stream_text_mismatch",
        message: "Concatenated text deltas did not equal the expected nonce.",
      };
    }
    return { passed: true };
  },
};
