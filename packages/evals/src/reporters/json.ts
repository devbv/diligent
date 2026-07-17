// @summary Serializes versioned eval reports with recursive credential redaction

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalSuiteReport } from "../task";

export interface EvalRedactionOptions {
  secrets?: readonly string[];
}

const CREDENTIAL_PATTERN = /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /Bearer\s+[^\s"',}]+/gi;
const SENSITIVE_KEY_PATTERN = /^(?:authorization|api[_-]?key)$/i;

export function serializeEvalReport(report: EvalSuiteReport, options: EvalRedactionOptions = {}): string {
  const sanitized = sanitizeValue(report, options.secrets?.filter(Boolean) ?? [], new WeakSet<object>());
  return `${JSON.stringify(sanitized, null, 2)}\n`;
}

export async function writeEvalReport(
  path: string,
  report: EvalSuiteReport,
  options: EvalRedactionOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, serializeEvalReport(report, options));
}

export function redactEvalText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(BEARER_PATTERN, "[REDACTED]").replace(CREDENTIAL_PATTERN, "[REDACTED]");
}

function sanitizeValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactEvalText(value, secrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secrets, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeValue(item, secrets, seen);
  }
  seen.delete(value);
  return output;
}
