// @summary Runtime-owned host function types and helpers for tool factory wiring and permission classification
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import type { UserInputRequest, UserInputResponse } from "./user-input-types";

export interface RuntimeToolHost {
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  ask?: (request: UserInputRequest) => Promise<UserInputResponse>;
  autoProgressMode?: boolean;
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
  if (host?.autoProgressMode) return autoResolveUserInput(request);
  if (!host?.ask) return null;
  return host.ask(request);
}

export function autoResolveUserInput(request: UserInputRequest): UserInputResponse {
  return {
    answers: Object.fromEntries(
      request.questions.map((question) => {
        const first = question.options[0];
        const value = first?.value ?? first?.label ?? "";
        return [question.id, question.allow_multiple ? [value] : value];
      }),
    ),
  };
}
