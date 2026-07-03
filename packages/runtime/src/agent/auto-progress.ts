// @summary System prompt section for auto progress mode

import type { SystemSection } from "@diligent/core/llm/types";

export const AUTO_PROGRESS_SYSTEM_PROMPT = [
  "The user has enabled Auto progress mode.",
  "Do not ask the user to choose between options or confirm routine next steps.",
  "Do not ask progress-blocking questions in plain text, such as asking the user to select from a list.",
  "Use the current task context to choose the best option or make a reasonable assumption, then continue.",
  "Only stop for user input when continuing requires unavailable secrets, credentials, external account access, or an unsafe/destructive action that cannot be reasonably avoided.",
  "Show the finished result instead of intermediate confirmation choices.",
].join("\n");

export function applyAutoProgressPrompt(systemPrompt: SystemSection[], enabled: boolean): SystemSection[] {
  if (!enabled) return systemPrompt;
  return [
    ...systemPrompt,
    {
      label: "auto_progress_mode",
      content: AUTO_PROGRESS_SYSTEM_PROMPT,
    },
  ];
}
