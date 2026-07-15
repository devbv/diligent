// @summary Public structured logging contracts shared by logger and sink implementations.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope: string;
  event: string;
  message: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  component?: string;
  error?: NormalizedError;
  fields: LogFields;
}

export interface LogContext {
  scope?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  component?: string;
  fields?: LogFields;
}

export interface LogInput extends LogContext {
  message?: string;
  error?: unknown;
}

export type LogSink = (record: LogRecord) => void | PromiseLike<void>;

export interface Logger {
  child(context?: LogContext): Logger;
  debug(event: string, input: LogInput | string): void;
  info(event: string, input: LogInput | string): void;
  warn(event: string, input: LogInput | string): void;
  error(event: string, input: LogInput | string): void;
}

export interface CreateLoggerOptions {
  scope: string;
  sink?: LogSink;
  clock?: () => Date;
  minimumLevel?: LogLevel;
  context?: LogContext;
}

export interface ConsoleLike {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

export interface CreateConsoleSinkOptions {
  console?: ConsoleLike;
  format?: "text" | "json";
}

export interface FormatLogRecordTextOptions {
  includeTimestamp?: boolean;
  includeSessionId?: boolean;
}
