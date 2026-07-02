// @summary Builds structured Studio instance tool status results for recoverable domain failures.

import type { ToolRenderPayload, ToolResult } from "../types";

export type InstanceOperation = "instance.read" | "instance.upsert" | "instance.move" | "instance.delete";
export type InstanceGuidRole = "target" | "parent" | "new_parent";
export type MissingGuidCode = "missing_target_guid" | "missing_parent_guid" | "missing_new_parent_guid";
export type InvalidOperationCode = "protected_service_class" | "invalid_parent_class";

export type MissingGuidStatus = {
  kind: "missing_guid";
  code: MissingGuidCode;
  operation: InstanceOperation;
  guid: string;
  role: InstanceGuidRole;
  message: string;
  requiresReadback: true;
  suggestedTool: "studiorpc_level_browse";
};

export type InvalidOperationStatus = {
  kind: "invalid_operation";
  code: InvalidOperationCode;
  operation: InstanceOperation;
  guid: string;
  role: InstanceGuidRole;
  class?: string;
  message: string;
  requiresReadback: false;
};

export type InstanceToolStatus = MissingGuidStatus | InvalidOperationStatus;

const missingGuidCodeByRole: Record<InstanceGuidRole, MissingGuidCode> = {
  target: "missing_target_guid",
  parent: "missing_parent_guid",
  new_parent: "missing_new_parent_guid",
};

function roleLabel(role: InstanceGuidRole): string {
  return role.replace("_", " ");
}

function statusRender(status: InstanceToolStatus): ToolRenderPayload {
  const items = [
    { key: "kind", value: status.kind },
    { key: "code", value: status.code },
    { key: "operation", value: status.operation },
    { key: "role", value: status.role },
    { key: "guid", value: status.guid },
    { key: "requiresReadback", value: String(status.requiresReadback) },
    ...("suggestedTool" in status ? [{ key: "suggestedTool", value: status.suggestedTool }] : []),
    ...("class" in status && status.class ? [{ key: "class", value: status.class }] : []),
  ];

  return {
    inputSummary: `${status.operation} ${roleLabel(status.role)} ${status.guid}`,
    outputSummary: status.code,
    blocks: [
      { type: "key_value", title: "Studio instance status", items },
      { type: "summary", text: status.message, tone: status.kind === "missing_guid" ? "warning" : "danger" },
    ],
  };
}

export function instanceStatusResult(status: InstanceToolStatus): ToolResult {
  return {
    output: statusOutput(status),
    render: statusRender(status),
    metadata: {
      error: true,
      method: status.operation,
      status,
    },
  };
}

function statusOutput(status: InstanceToolStatus): string {
  return ["<studio_instance_status>", JSON.stringify(status), "</studio_instance_status>", status.message].join("\n");
}

export class InstanceToolStatusError extends Error {
  readonly status: InstanceToolStatus;

  constructor(status: InstanceToolStatus) {
    super(status.message);
    this.name = "InstanceToolStatusError";
    this.status = status;
  }
}

export function missingGuidResult(input: {
  operation: InstanceOperation;
  guid: string;
  role: InstanceGuidRole;
}): ToolResult {
  return instanceStatusResult(missingGuidStatus(input));
}

export function missingGuidError(input: {
  operation: InstanceOperation;
  guid: string;
  role: InstanceGuidRole;
}): InstanceToolStatusError {
  return new InstanceToolStatusError(missingGuidStatus(input));
}

export function invalidInstanceOperationError(input: {
  operation: InstanceOperation;
  code: InvalidOperationCode;
  guid: string;
  role: InstanceGuidRole;
  class?: string;
  message: string;
}): InstanceToolStatusError {
  return new InstanceToolStatusError({
    kind: "invalid_operation",
    code: input.code,
    operation: input.operation,
    guid: input.guid,
    role: input.role,
    ...(input.class ? { class: input.class } : {}),
    message: input.message,
    requiresReadback: false,
  });
}

export function resultFromInstanceToolStatusError(error: unknown): ToolResult | undefined {
  if (error instanceof InstanceToolStatusError) {
    return instanceStatusResult(error.status);
  }
  return undefined;
}

function missingGuidStatus(input: {
  operation: InstanceOperation;
  guid: string;
  role: InstanceGuidRole;
}): MissingGuidStatus {
  const role = roleLabel(input.role);
  return {
    kind: "missing_guid",
    code: missingGuidCodeByRole[input.role],
    operation: input.operation,
    guid: input.guid,
    role: input.role,
    message: `Missing ${role} GUID for ${input.operation}: ${input.guid}. Read the current hierarchy with studiorpc_level_browse before retrying.`,
    requiresReadback: true,
    suggestedTool: "studiorpc_level_browse",
  };
}
