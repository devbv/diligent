// @summary Creates immutable contextual loggers with safe error normalization and dynamic default sinks.

import { createConsoleSink } from "./sinks";
import type {
  CreateLoggerOptions,
  LogContext,
  Logger,
  LogInput,
  LogLevel,
  LogRecord,
  LogSink,
  NormalizedError,
} from "./types";

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let defaultSink: LogSink = createConsoleSink();

interface StoredContext {
  scope?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  component?: string;
  fields: Readonly<Record<string, unknown>>;
}

function safeProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function safeString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  try {
    return value === undefined ? fallback : String(value);
  } catch {
    return fallback;
  }
}

/** Safely converts an arbitrary thrown value into serializable error data. */
export function normalizeError(value: unknown): NormalizedError {
  return normalizeErrorWithSeen(value, new WeakSet<object>());
}

function normalizeErrorWithSeen(value: unknown, seen: WeakSet<object>): NormalizedError {
  if (typeof value === "string") {
    return { name: "Error", message: value };
  }

  if ((typeof value === "object" || typeof value === "function") && value !== null) {
    if (seen.has(value)) return { name: "Error", message: "[Circular error cause]" };
    seen.add(value);
  }

  const messageValue = safeProperty(value, "message");
  const nameValue = safeProperty(value, "name");
  const stackValue = safeProperty(value, "stack");
  const causeValue = safeProperty(value, "cause");
  const normalized: NormalizedError = {
    name: safeString(nameValue, "Error") || "Error",
    message:
      messageValue === undefined ? safeString(value, "Unknown error") : safeString(messageValue, "Unknown error"),
  };

  if (typeof stackValue === "string") normalized.stack = stackValue;
  if (causeValue !== undefined) normalized.cause = normalizeErrorCause(causeValue, seen);
  return normalized;
}

function normalizeErrorCause(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  return normalizeErrorWithSeen(value, seen);
}

function snapshotContext(context: LogContext | undefined): StoredContext {
  return {
    ...(context?.scope !== undefined && { scope: context.scope }),
    ...(context?.sessionId !== undefined && { sessionId: context.sessionId }),
    ...(context?.threadId !== undefined && { threadId: context.threadId }),
    ...(context?.turnId !== undefined && { turnId: context.turnId }),
    ...(context?.component !== undefined && { component: context.component }),
    fields: { ...(context?.fields ?? {}) },
  };
}

function mergeContext(parent: StoredContext, child: LogContext): StoredContext {
  return {
    scope: child.scope ?? parent.scope,
    sessionId: child.sessionId ?? parent.sessionId,
    threadId: child.threadId ?? parent.threadId,
    turnId: child.turnId ?? parent.turnId,
    component: child.component ?? parent.component,
    fields: { ...parent.fields, ...(child.fields ?? {}) },
  };
}

function safelyWrite(sink: LogSink, record: LogRecord): void {
  try {
    const result = sink(record);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Logging is observational and must never alter application control flow.
  }
}

class StructuredLogger implements Logger {
  constructor(
    private readonly scope: string,
    private readonly explicitSink: LogSink | undefined,
    private readonly clock: () => Date,
    private readonly minimumLevel: LogLevel,
    private readonly context: StoredContext,
  ) {}

  child(context: LogContext = {}): Logger {
    const mergedContext = mergeContext(this.context, context);
    return new StructuredLogger(
      mergedContext.scope ?? this.scope,
      this.explicitSink,
      this.clock,
      this.minimumLevel,
      mergedContext,
    );
  }

  debug(event: string, input: LogInput | string): void {
    this.write("debug", event, input);
  }

  info(event: string, input: LogInput | string): void {
    this.write("info", event, input);
  }

  warn(event: string, input: LogInput | string): void {
    this.write("warn", event, input);
  }

  error(event: string, input: LogInput | string): void {
    this.write("error", event, input);
  }

  private write(level: LogLevel, event: string, input: LogInput | string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minimumLevel]) return;

    const details: LogInput = typeof input === "string" ? { message: input } : input;
    const timestamp = this.clock().toISOString();
    const sessionId = details.sessionId ?? this.context.sessionId;
    const threadId = details.threadId ?? this.context.threadId;
    const turnId = details.turnId ?? this.context.turnId;
    const component = details.component ?? this.context.component;
    const record: LogRecord = {
      timestamp,
      level,
      scope: this.scope,
      event,
      message: details.message ?? event,
      ...(sessionId !== undefined && { sessionId }),
      ...(threadId !== undefined && { threadId }),
      ...(turnId !== undefined && { turnId }),
      ...(component !== undefined && { component }),
      ...(details.error !== undefined && { error: normalizeError(details.error) }),
      fields: { ...this.context.fields, ...(details.fields ?? {}) },
    };

    safelyWrite(this.explicitSink ?? defaultSink, record);
  }
}

/** Creates a structured logger whose children inherit immutable context snapshots. */
export function createLogger(options: CreateLoggerOptions): Logger {
  return new StructuredLogger(
    options.scope,
    options.sink,
    options.clock ?? (() => new Date()),
    options.minimumLevel ?? "debug",
    snapshotContext(options.context),
  );
}

/** Replaces the dynamic default sink used by every logger without an explicit sink. */
export function setDefaultLogSink(sink: LogSink): void {
  defaultSink = sink;
}

/** Restores the dynamic default sink to a fresh browser-safe console sink. */
export function resetDefaultLogSinkForTests(): void {
  defaultSink = createConsoleSink();
}

/** A logger implementation that discards all records without allocating child loggers. */
export const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
