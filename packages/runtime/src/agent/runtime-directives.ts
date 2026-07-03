// @summary Transient model directives derived from runtime settings

import type { Message } from "@diligent/core/types";

export interface RuntimeDirectiveSettings {
  autoProgressMode?: boolean;
}

const AUTO_PROGRESS_DIRECTIVE = [
  "Runtime directive for this turn: Auto progress mode is enabled.",
  "Do not ask the user to choose between options or confirm routine next steps during this turn.",
  "Do not call request_user_input for routine choices; decide yourself using the current task context, choose the best option or a reasonable assumption, and continue.",
  "Only stop for user input when continuing would require unavailable secrets, credentials, external account access, or an unsafe/destructive action that cannot be reasonably avoided.",
  "Show the user the finished result, not the intermediate confirmation choices.",
].join("\n");

export function buildRuntimeDirectiveMessages(settings: RuntimeDirectiveSettings): Message[] {
  if (!settings.autoProgressMode) return [];
  return [
    {
      role: "user",
      content: AUTO_PROGRESS_DIRECTIVE,
      timestamp: 0,
    },
  ];
}
