// @summary Provides safe console and fanout sinks plus a recursion marker for console interceptors.

import type { ConsoleLike, CreateConsoleSinkOptions, FormatLogRecordTextOptions, LogRecord, LogSink } from "./types";

let structuredConsoleWriteDepth = 0;

/** Reports whether the current synchronous console call originated from the structured console sink. */
export function isStructuredConsoleWriteInProgress(): boolean {
  return structuredConsoleWriteDepth > 0;
}

function withConsoleWriteMarker(write: () => void): void {
  structuredConsoleWriteDepth += 1;
  try {
    write();
  } finally {
    structuredConsoleWriteDepth -= 1;
  }
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unserializable]";
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string" && !/\s/.test(value)) return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return safeJson(value);
}

function appendTextMetadata(message: string, record: LogRecord): string {
  const metadata: string[] = [];
  metadata.push(`level=${record.level}`);
  metadata.push(`scope=${record.scope}`);
  metadata.push(`event=${record.event}`);
  if (record.threadId !== undefined) metadata.push(`threadId=${record.threadId}`);
  if (record.turnId !== undefined) metadata.push(`turnId=${record.turnId}`);
  if (record.component !== undefined) metadata.push(`component=${record.component}`);
  if (record.error !== undefined) metadata.push(`error=${safeJson(record.error)}`);
  for (const [key, value] of Object.entries(record.fields)) {
    metadata.push(`${key}=${textValue(value)}`);
  }
  return metadata.length === 0 ? message : `${message} ${metadata.join(" ")}`;
}

/** Formats a log record as text with optional timestamp and session prefixes. */
export function formatLogRecordText(record: LogRecord, options: FormatLogRecordTextOptions = {}): string {
  const includeTimestamp = options.includeTimestamp ?? true;
  const includeSessionId = options.includeSessionId ?? true;
  const requiredContext = [
    ...(includeTimestamp ? [`timestamp=${record.timestamp}`] : []),
    ...(includeSessionId ? [`sessionId=${record.sessionId ?? "n/a"}`] : []),
  ].join(" ");
  const prefix = /^(\[[^\]\r\n]+\])(?:\s*)([\s\S]*)$/.exec(record.message);
  const body = prefix?.[2] ?? record.message;
  const message = prefix
    ? [prefix[1], requiredContext, body].filter((part) => part.length > 0).join(" ")
    : [requiredContext, body].filter((part) => part.length > 0).join(" ");
  return appendTextMetadata(message, record);
}

function resolveConsole(injected: ConsoleLike | undefined): ConsoleLike | undefined {
  if (injected !== undefined) return injected;
  const candidate = (globalThis as { console?: ConsoleLike }).console;
  return candidate;
}

/** Creates a browser-safe sink that emits one text or JSON argument to the matching console method. */
export function createConsoleSink(options: CreateConsoleSinkOptions = {}): LogSink {
  const target = resolveConsole(options.console);
  const format = options.format ?? "text";
  return (record) => {
    if (target === undefined) return;
    const output = format === "json" ? safeJson(record) : formatLogRecordText(record);
    withConsoleWriteMarker(() => {
      target[record.level](output);
    });
  };
}

function safelyFanOut(sink: LogSink, record: LogRecord): void {
  try {
    const result = sink(record);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {
    // One destination must not prevent records from reaching other destinations.
  }
}

/** Creates a sink that independently forwards each record to every supplied sink. */
export function createFanoutSink(sinks: readonly LogSink[]): LogSink {
  const destinations = [...sinks];
  return (record) => {
    for (const sink of destinations) safelyFanOut(sink, record);
  };
}
