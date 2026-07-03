// @summary Runtime-owned host function types and helpers for tool factory wiring and permission classification
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import type { UserInputRequest, UserInputResponse } from "./user-input-types";

export interface RuntimeToolHost {
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  ask?: (request: UserInputRequest) => Promise<UserInputResponse>;
  getAutoProgressMode?: () => boolean;
}

export async function requestToolApproval(
  host: RuntimeToolHost | undefined,
  request: ApprovalRequest,
): Promise<ApprovalResponse> {
  if (!host?.approve) return "once";
  return host.approve(request);
}

export async function requestToolUserInput(
  host: RuntimeToolHost | undefined,
  request: UserInputRequest,
): Promise<UserInputResponse | null> {
  if (!host?.ask) return null;
  return host.ask(request);
}

export function formatAutoProgressUserInputDirective(request: UserInputRequest): string {
  const questions = request.questions
    .map((question) => {
      const options = question.options
        .map((option) => {
          const value = option.value ? ` (value: ${option.value})` : "";
          return `- ${option.label}${value}: ${option.description}`;
        })
        .join("\n");
      const selection = question.allow_multiple ? "Select one or more options if appropriate." : "Select one option.";
      const secret = question.is_secret
        ? "\nThis question is marked secret; do not invent credentials or secrets that are unavailable."
        : "";
      return [`[${question.header}] ${question.question}`, selection, "Options:", options, secret].join("\n");
    })
    .join("\n\n");

  return [
    "Auto progress mode is enabled for this turn.",
    "Do not ask the user or wait for a user answer.",
    "Answer the following question(s) yourself using the current task context, choose the best option(s) or a reasonable assumption, and continue.",
    "Do not call request_user_input again for these question(s).",
    "",
    questions,
  ].join("\n");
}
