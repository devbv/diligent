// @summary Provider-only model directives derived from runtime settings

import type { Message } from "@diligent/core/types";

const AUTO_PROGRESS_ENABLED_DIRECTIVE = [
  "Runtime directive: Auto progress mode is enabled from now on.",
  "Do not ask the user to choose between options or confirm routine next steps while this mode remains enabled.",
  "Do not call request_user_input for routine choices; decide yourself using the current task context, choose the best option or a reasonable assumption, and continue.",
  "Only stop for user input when continuing would require unavailable secrets, credentials, external account access, or an unsafe/destructive action that cannot be reasonably avoided.",
  "Show the user the finished result, not the intermediate confirmation choices.",
].join("\n");

const AUTO_PROGRESS_DISABLED_DIRECTIVE = [
  "Runtime directive: Auto progress mode is disabled from now on.",
  "Resume the default confirmation behavior.",
  "Use request_user_input when a user decision is needed and the existing instructions say to ask.",
].join("\n");

export function buildAutoProgressModeMessage(enabled: boolean, timestamp: number): Message {
  return {
    role: "user",
    content: enabled ? AUTO_PROGRESS_ENABLED_DIRECTIVE : AUTO_PROGRESS_DISABLED_DIRECTIVE,
    timestamp,
  };
}
