// @summary Exports the zero-dependency structured logging API.

export {
  createLogger,
  noopLogger,
  normalizeError,
  resetDefaultLogSinkForTests,
  setDefaultLogSink,
} from "./logger";
export {
  createConsoleSink,
  createFanoutSink,
  formatLogRecordText,
  isStructuredConsoleWriteInProgress,
} from "./sinks";
export type {
  ConsoleLike,
  CreateConsoleSinkOptions,
  CreateLoggerOptions,
  FormatLogRecordTextOptions,
  LogContext,
  LogFields,
  Logger,
  LogInput,
  LogLevel,
  LogRecord,
  LogSink,
  NormalizedError,
} from "./types";
