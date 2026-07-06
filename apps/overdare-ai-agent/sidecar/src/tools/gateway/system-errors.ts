// @summary Unauthenticated OVERDARE gateway system-error forwarding for sidecar console output.

import { DEBUG, resolveEndpoint } from "./shared";

interface SystemErrorEvent {
  source: string;
  event_ts: string;
  message: string;
  severity?: string;
  component?: string;
  version?: string;
  error_type?: string;
  stack?: string;
  fingerprint?: string;
  project_id?: string;
  session_id?: string;
  context?: Record<string, unknown>;
}

interface ConsoleSystemErrorForwarderOptions {
  source: string;
  component?: string;
  version?: string;
  projectId?: string;
  sessionId?: string;
}

type ConsoleLevel = "debug" | "error" | "info" | "log" | "warn";

const CONSOLE_SEVERITY: Record<ConsoleLevel, string> = {
  debug: "debug",
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
      enqueueSystemErrorFromConsole(args, options, CONSOLE_SEVERITY[level]);
    };
  }
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
  const event = buildSystemErrorEvent(args, options, severity);
  if (!event.message) return;

  const url = `${resolveEndpoint()}/v1/system-errors`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withoutNullish(event)),
    });
    if (DEBUG) {
      const body = await res.text().catch(() => "");
      originalConsole.error?.(`[gateway] system-error POST ${url} → ${res.status} ${body}`.trim());
    }
  } catch (err) {
    if (DEBUG) originalConsole.error?.(`[gateway] system-error POST ${url} failed:`, err);
  }
}

function buildSystemErrorEvent(
  args: unknown[],
  options: ConsoleSystemErrorForwarderOptions,
  severity: string,
): SystemErrorEvent {
  const firstError = args.find((arg): arg is Error => arg instanceof Error);
  const message = formatConsoleArgs(args).slice(0, 4096);
  const stack = firstError?.stack?.slice(0, 65536);
  const errorType = firstError?.name?.slice(0, 256);

  return {
    source: options.source.slice(0, 128),
    event_ts: new Date().toISOString(),
    severity,
    message,
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

function buildFingerprint(args: unknown[], error: Error | undefined): string | undefined {
  if (error?.name && error.message) return `${error.name}:${error.message}`.slice(0, 256);
  const firstString = args.find((arg): arg is string => typeof arg === "string")?.trim();
  return firstString ? firstString.slice(0, 256) : undefined;
}

function withoutNullish(event: SystemErrorEvent): SystemErrorEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined && value !== null),
  ) as SystemErrorEvent;
}
