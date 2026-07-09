// @summary Builds structured Studio instance tool status results for recoverable domain failures.

import type { ToolRenderPayload, ToolResult } from "../types";

export type LevelApplyStatus =
  | { kind: "applied" }
  | { kind: "applied_with_warnings"; warnings: string[] }
  | { kind: "failed"; errors: string[] }
  | { kind: "partial"; warnings?: string[]; errors?: string[]; requiresReadback: true }
  | { kind: "unknown"; requiresReadback: true };

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeLevelApplyResult(result: unknown): LevelApplyStatus {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { kind: "unknown", requiresReadback: true };
  }

  const rec = result as Record<string, unknown>;

  if (!("success" in rec)) {
    return { kind: "unknown", requiresReadback: true };
  }

  const warnings = toStringArray(rec.warnings);
  const errors = toStringArray(rec.errors);

  if (rec.success === true) {
    if (warnings.length > 0) {
      return { kind: "applied_with_warnings", warnings };
    }
    return { kind: "applied" };
  }

  if (rec.success === false) {
    if (warnings.length > 0) {
      return { kind: "partial", warnings, ...(errors.length > 0 ? { errors } : {}), requiresReadback: true };
    }
    if (errors.length > 0) {
      return { kind: "failed", errors };
    }
    return { kind: "unknown", requiresReadback: true };
  }

  return { kind: "unknown", requiresReadback: true };
}

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

const statusOutputOpen = "<studio_instance_status>";
const statusOutputClose = "</studio_instance_status>";

type StatusRenderItem = { key: string; value: string };

function roleLabel(role: InstanceGuidRole): string {
  return role.replace("_", " ");
}

function statusRender(status: InstanceToolStatus): ToolRenderPayload {
  return {
    inputSummary: `${status.operation} ${roleLabel(status.role)} ${status.guid}`,
    outputSummary: status.code,
    blocks: [
      { type: "key_value", title: "Studio instance status", items: statusRenderItems(status) },
      { type: "summary", text: status.message, tone: status.kind === "missing_guid" ? "warning" : "danger" },
    ],
  };
}

function statusRenderItems(status: InstanceToolStatus): StatusRenderItem[] {
  const items: StatusRenderItem[] = [
    { key: "kind", value: status.kind },
    { key: "code", value: status.code },
    { key: "operation", value: status.operation },
    { key: "role", value: status.role },
    { key: "guid", value: status.guid },
    { key: "requiresReadback", value: String(status.requiresReadback) },
  ];

  if ("suggestedTool" in status) {
    items.push({ key: "suggestedTool", value: status.suggestedTool });
  }
  if ("class" in status && status.class) {
    items.push({ key: "class", value: status.class });
  }

  return items;
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
  const serializedStatus = JSON.stringify(status);
  return `${statusOutputOpen}\n${serializedStatus}\n${statusOutputClose}\n${status.message}`;
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
