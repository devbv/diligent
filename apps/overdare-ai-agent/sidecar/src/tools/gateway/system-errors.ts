// @summary Unauthenticated OVERDARE gateway system-log forwarding for structured and legacy logs.

import {
  formatLogRecordText,
  isStructuredConsoleWriteInProgress,
  type LogRecord,
  type LogSink,
} from "@diligent/logging";
import { DEBUG, resolveEndpoint } from "./shared";

interface SystemLogEvent {
  source: string;
  event_ts: string;
  message: string;
  severity?: string;
  user_id?: string;
  component?: string;
  version?: string;
  error_type?: string;
  stack?: string;
  fingerprint?: string;
  project_id?: string;
  session_id?: string;
  context?: Record<string, unknown>;
}

export interface ConsoleSystemErrorForwarderOptions {
  source: string;
  userId?: string;
  component?: string;
  version?: string;
  projectId?: string;
  sessionId?: string;
}

type ConsoleLevel = "debug" | "error" | "info" | "log" | "warn";

const CONSOLE_SEVERITY: Record<ConsoleLevel, string | undefined> = {
  debug: undefined,
  error: "error",
  info: "info",
  log: "info",
  warn: "warning",
};

let installed = false;
let originalConsole: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};

export function installConsoleSystemErrorForwarder(options: ConsoleSystemErrorForwarderOptions): void {
  if (installed) return;
  installed = true;
  originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  for (const level of Object.keys(CONSOLE_SEVERITY) as ConsoleLevel[]) {
    console[level] = (...args: unknown[]) => {
      originalConsole[level]?.(...args);
      // The structured record already reaches the gateway through createGatewaySystemLogSink.
      // Preserve its local console output, but do not forward that intercepted write a second time.
      if (isStructuredConsoleWriteInProgress()) return;
      const severity = CONSOLE_SEVERITY[level];
      if (severity) enqueueSystemErrorFromConsole(args, options, severity);
    };
  }
}

export function resetConsoleSystemErrorForwarderForTests(): void {
  installed = false;
  originalConsole = {};
}

export function enqueueSystemErrorFromConsole(
  args: unknown[],
  options: ConsoleSystemErrorForwarderOptions,
  severity = "error",
): void {
  const timer = setTimeout(() => {
    void postSystemErrorFromConsole(args, options, severity);
  }, 0);
  timer.unref?.();
}

export async function postSystemErrorFromConsole(
  args: unknown[],
  options: ConsoleSystemErrorForwarderOptions,
  severity = "error",
): Promise<void> {
  const event = buildSystemLogEvent(args, options, severity);
  if (!event.message) return;

  await postSystemLogEvent(event);
}

/**
 * Creates a best-effort structured sink. It intentionally schedules transmission on the next
 * timer turn: logging must never put gateway I/O or a fetch promise on the application stack.
 */
export function createGatewaySystemLogSink(options: ConsoleSystemErrorForwarderOptions): LogSink {
  return (record) => {
    if (record.level === "debug") return;
    const timer = setTimeout(() => {
      void postStructuredSystemLog(record, options);
    }, 0);
    timer.unref?.();
  };
}

/** Posts one structured record. Exported to make the wire mapping directly contract-testable. */
export async function postStructuredSystemLog(
  record: LogRecord,
  options: ConsoleSystemErrorForwarderOptions,
): Promise<void> {
  if (record.level === "debug" || !record.message) return;

  const sessionId = record.sessionId ?? options.sessionId;
  const remoteRecord = sessionId === record.sessionId ? record : { ...record, sessionId };

  const context: Record<string, unknown> = {
    scope: record.scope,
    event: record.event,
    fields: record.fields,
  };
  if (record.threadId !== undefined) context.threadId = record.threadId;
  if (record.turnId !== undefined) context.turnId = record.turnId;
  if (record.error?.cause !== undefined) context.errorCause = record.error.cause;

  const event: SystemLogEvent = {
    source: options.source.slice(0, 128),
    // This must be the exact timestamp allocated by the logger, not a second wall-clock read.
    event_ts: record.timestamp,
    severity: record.level === "warn" ? "warning" : record.level,
    // Reuse the console representation but keep timestamp envelope-only as event_ts.
    message: formatLogRecordText(remoteRecord, { includeTimestamp: false }).slice(0, 4096),
    user_id: options.userId?.slice(0, 256),
    component: (record.component ?? record.scope).slice(0, 128),
    version: options.version?.slice(0, 64),
    error_type: record.error?.name.slice(0, 256),
    stack: record.error?.stack?.slice(0, 65536),
    fingerprint:
      record.error?.name && record.error.message
        ? `${record.error.name}:${record.error.message}`.slice(0, 256)
        : undefined,
    project_id: options.projectId?.slice(0, 256),
    session_id: sessionId?.slice(0, 256),
    context,
  };

  await postSystemLogEvent(event);
}

async function postSystemLogEvent(event: SystemLogEvent): Promise<void> {
  if (!event.message) return;

  const url = `${resolveEndpoint()}/v1/system-logs`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withoutNullish(event)),
    });
    if (DEBUG && !res.ok) {
      const body = await res.text().catch(() => "");
      originalConsole.error?.(`[gateway] system-log POST ${url} → ${res.status} ${body}`.trim());
    }
  } catch (err) {
    if (DEBUG) originalConsole.error?.(`[gateway] system-log POST ${url} failed:`, err);
  }
}

function buildSystemLogEvent(
  args: unknown[],
  options: ConsoleSystemErrorForwarderOptions,
  severity: string,
): SystemLogEvent {
  const firstError = args.find((arg): arg is Error => arg instanceof Error);
  const message = stripRemoteLlmRetryTimestamp(formatConsoleArgs(args)).slice(0, 4096);
  const stack = firstError?.stack?.slice(0, 65536);
  const errorType = firstError?.name?.slice(0, 256);

  return {
    source: options.source.slice(0, 128),
    event_ts: new Date().toISOString(),
    severity,
    message,
    user_id: options.userId?.slice(0, 256),
    component: options.component?.slice(0, 128),
    version: options.version?.slice(0, 64),
    error_type: errorType,
    stack,
    fingerprint: buildFingerprint(args, firstError),
    project_id: options.projectId?.slice(0, 256),
    session_id: options.sessionId?.slice(0, 256),
    context: { argv: process.argv.slice(1, 4), pid: process.pid },
  };
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.message || arg.name;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .trim();
}

function stripRemoteLlmRetryTimestamp(message: string): string {
  if (!message.startsWith("[llm:retry]")) return message;

  return message
    .replace(/\stimestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?=\s|$)/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildFingerprint(args: unknown[], error: Error | undefined): string | undefined {
  if (error?.name && error.message) return `${error.name}:${error.message}`.slice(0, 256);
  const firstString = args.find((arg): arg is string => typeof arg === "string")?.trim();
  return firstString ? firstString.slice(0, 256) : undefined;
}

function withoutNullish(event: SystemLogEvent): SystemLogEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined && value !== null),
  ) as SystemLogEvent;
}
