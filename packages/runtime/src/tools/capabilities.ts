// @summary Runtime-owned host function types and helpers for tool factory wiring and permission classification
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import type { UserInputRequest, UserInputResponse } from "./user-input-types";

export interface RuntimeToolHost {
  approve?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  ask?: (request: UserInputRequest) => Promise<UserInputResponse>;
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
