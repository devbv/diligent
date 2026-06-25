#!/usr/bin/env bun
// @summary Fixed-port development switchboard for the active OVERDARE Portless target.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_LISTEN = "0.0.0.0:11000";
const DEFAULT_PORTLESS_ORIGIN = "http://127.0.0.1:11001";
const DEFAULT_STATE_FILE = join(homedir(), ".diligent-dev-switchboard", "state.json");

interface DevTarget {
  host: string;
  cwd?: string;
  url?: string;
  updatedAt: string;
}

interface SwitchboardState {
  activeHost?: string;
  updatedAt?: string;
  targets?: Record<string, DevTarget>;
}

interface ListenAddress {
  hostname: string;
  port: number;
}

interface CommonOptions {
  stateFile: string;
}

interface StartOptions extends CommonOptions {
  listen: ListenAddress;
  portlessOrigin: string;
  defaultHost?: string;
}

interface RegisterOptions extends CommonOptions {
  host: string;
  activate: boolean;
  cwd?: string;
  url?: string;
}

interface SwitchboardWsData {
  activeHost: string;
  targetUrl: string;
  pending: Array<string | ArrayBuffer | Uint8Array>;
  upstream?: WebSocket;
  upstreamOpen: boolean;
}

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/dev-switchboard.ts start [options]
  bun run scripts/dev-switchboard.ts register <portless-host> [options]
  bun run scripts/dev-switchboard.ts use <portless-host> [options]
  bun run scripts/dev-switchboard.ts list [options]

Commands:
  start       Start the fixed Windows-facing proxy and small control UI
  register    Add or refresh a worktree target; activates it by default
  use         Switch the active target
  list        Print active target and registered worktree targets

Start options:
  --listen <host:port>       Fixed Windows-facing address (default: ${DEFAULT_LISTEN})
  --portless <origin>        Portless proxy origin (default: ${DEFAULT_PORTLESS_ORIGIN})
  --default-host <host>      Fallback host when no active state exists

Register options:
  --cwd <path>               Worktree cwd shown in the UI
  --url <url>                Full Portless URL for the target
  --no-activate              Register without switching to this target

Common options:
  --state-file <path>        State file (default: ${DEFAULT_STATE_FILE})
  --help                     Show this help
`);
}

function parsePort(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port: ${value}`);
  }
  return parsed;
}

function parseListenAddress(value: string): ListenAddress {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--listen cannot be empty");
  }
  if (/^\d+$/.test(trimmed)) {
    return { hostname: "0.0.0.0", port: parsePort(trimmed, "--listen") };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) {
    return { hostname: trimmed, port: 11000 };
  }

  const hostname = trimmed.slice(0, lastColon).trim() || "0.0.0.0";
  const port = parsePort(trimmed.slice(lastColon + 1), "--listen");
  return { hostname, port };
}

function normalizeTargetHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Host cannot be empty");
  }

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return new URL(`http://${trimmed}`).hostname.toLowerCase();
  }
}

function parseCommonOptions(values: Record<string, string | boolean | undefined>): CommonOptions {
  return {
    stateFile: resolve(process.cwd(), String(values["state-file"] || DEFAULT_STATE_FILE)),
  };
}

function parseStartOptions(argv: string[]): StartOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: "string" },
      portless: { type: "string" },
      "default-host": { type: "string" },
      "state-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return null;
  }

  return {
    ...parseCommonOptions(values),
    listen: parseListenAddress(values.listen?.trim() || DEFAULT_LISTEN),
    portlessOrigin: values.portless?.trim() || DEFAULT_PORTLESS_ORIGIN,
    defaultHost: values["default-host"]?.trim() ? normalizeTargetHost(values["default-host"]) : undefined,
  };
}

function parseCommonCommandOptions(argv: string[]): { options: CommonOptions; positionals: string[] } | null {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "state-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return null;
  }

  return { options: parseCommonOptions(values), positionals };
}

function parseRegisterOptions(argv: string[]): RegisterOptions | null {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      cwd: { type: "string" },
      url: { type: "string" },
      "no-activate": { type: "boolean" },
      "state-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return null;
  }

  const [host] = positionals;
  if (!host) {
    throw new Error("Missing host: dev-switchboard register <portless-host>");
  }

  return {
    ...parseCommonOptions(values),
    host: normalizeTargetHost(host),
    activate: values["no-activate"] !== true,
    cwd: values.cwd?.trim() || undefined,
    url: values.url?.trim() || undefined,
  };
}

async function readState(stateFile: string): Promise<SwitchboardState> {
  if (!existsSync(stateFile)) {
    return {};
  }

  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as SwitchboardState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(stateFile: string, next: SwitchboardState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function sortedTargets(state: SwitchboardState): DevTarget[] {
  return Object.values(state.targets ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function resolveActiveHost(options: StartOptions): Promise<string | null> {
  const state = await readState(options.stateFile);
  return state.activeHost ?? options.defaultHost ?? null;
}

function targetUrl(requestUrl: string, activeHost: string, portlessOrigin: string, protocol?: "ws:" | "wss:"): URL {
  const incoming = new URL(requestUrl);
  const portless = new URL(portlessOrigin);
  const target = new URL(`${incoming.pathname}${incoming.search}`, portless);
  target.hostname = activeHost;
  if (protocol) {
    target.protocol = protocol;
  }
  return target;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

function htmlResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(value, { ...init, headers });
}

function renderGui(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Diligent Dev Switchboard</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; background: #f7f8fa; color: #16181c; }
    body { margin: 0; }
    main { width: min(900px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0; }
    header, .target { display: flex; align-items: center; gap: 12px; }
    header { justify-content: space-between; border-bottom: 1px solid #d7dde5; padding-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    button { height: 36px; padding: 0 12px; border: 1px solid #adb8c7; border-radius: 6px; background: #fff; color: inherit; font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    .target { justify-content: space-between; border-top: 1px solid #e0e5eb; padding: 12px 0; }
    .meta { color: #5d6673; font-size: 13px; }
    @media (prefers-color-scheme: dark) {
      :root { background: #101418; color: #eef2f6; }
      header, .target { border-color: #2a333d; }
      button { background: #171d23; border-color: #36424f; }
      .meta { color: #a8b3c1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Diligent Dev Switchboard</h1>
      <div>
        <div class="meta">Active: <code id="active">loading</code></div>
        <button type="button" id="refresh">Refresh</button>
      </div>
    </header>
    <section id="targets"></section>
  </main>
  <script>
    const activeEl = document.querySelector("#active");
    const targetsEl = document.querySelector("#targets");

    async function useHost(host) {
      await fetch("/_dev/api/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host }),
      });
      await load();
    }

    function render(state) {
      activeEl.textContent = state.activeHost || "none";
      targetsEl.replaceChildren();
      for (const target of state.targets) {
        const row = document.createElement("div");
        row.className = "target";
        const info = document.createElement("div");
        const title = document.createElement("code");
        title.textContent = target.host;
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = target.cwd || target.url || target.updatedAt;
        info.append(title, meta);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = target.host === state.activeHost ? "Active" : "Use";
        button.disabled = target.host === state.activeHost;
        button.addEventListener("click", () => useHost(target.host));
        row.append(info, button);
        targetsEl.append(row);
      }
      if (!state.targets.length) targetsEl.textContent = "No registered dev targets.";
    }

    async function load() {
      const response = await fetch("/_dev/api/state", { cache: "no-store" });
      render(await response.json());
    }

    document.querySelector("#refresh").addEventListener("click", load);
    load();
    setInterval(load, 3000);
  </script>
</body>
</html>`;
}

async function handleControlRequest(request: Request, url: URL, options: StartOptions): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/_dev") {
    return htmlResponse(renderGui());
  }

  if (request.method === "GET" && url.pathname === "/_dev/api/state") {
    const state = await readState(options.stateFile);
    return jsonResponse({
      activeHost: state.activeHost ?? options.defaultHost ?? null,
      updatedAt: state.updatedAt ?? null,
      targets: sortedTargets(state),
      portlessOrigin: options.portlessOrigin,
      stateFile: options.stateFile,
    });
  }

  if (request.method === "POST" && url.pathname === "/_dev/api/use") {
    const body = (await request.json()) as { host?: string };
    const activeHost = normalizeTargetHost(body.host ?? "");
    const state = await readState(options.stateFile);
    const now = new Date().toISOString();
    await writeState(options.stateFile, {
      ...state,
      activeHost,
      updatedAt: now,
      targets: {
        ...(state.targets ?? {}),
        [activeHost]: state.targets?.[activeHost] ?? { host: activeHost, updatedAt: now },
      },
    });
    return jsonResponse({ ok: true, activeHost });
  }

  if (url.pathname.startsWith("/_dev/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function proxyHttp(request: Request, activeHost: string, options: StartOptions): Promise<Response> {
  const target = targetUrl(request.url, activeHost, options.portlessOrigin);
  const headers = new Headers(request.headers);
  const incomingHost = headers.get("host");
  headers.delete("host");
  headers.delete("connection");
  headers.set("x-diligent-switchboard-target", activeHost);
  if (incomingHost) {
    headers.set("x-forwarded-host", incomingHost);
  }

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

function sendToClient(ws: Bun.ServerWebSocket<SwitchboardWsData>, data: unknown): void {
  if (typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array) {
    ws.send(data);
    return;
  }

  if (data instanceof Blob) {
    void data.arrayBuffer().then((buffer) => ws.send(buffer));
    return;
  }

  ws.send(String(data));
}

function sendToUpstream(upstream: WebSocket, data: string | ArrayBuffer | Uint8Array): void {
  if (upstream.readyState === WebSocket.OPEN) {
    upstream.send(data);
  }
}

async function startSwitchboard(options: StartOptions): Promise<void> {
  const server = Bun.serve<SwitchboardWsData>({
    hostname: options.listen.hostname,
    port: options.listen.port,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const controlResponse = await handleControlRequest(request, url, options);
      if (controlResponse) {
        return controlResponse;
      }

      const activeHost = await resolveActiveHost(options);
      if (!activeHost) {
        return htmlResponse('<a href="/_dev">Choose an active dev target</a>', { status: 503 });
      }

      if (isWebSocketRequest(request)) {
        const target = targetUrl(
          request.url,
          activeHost,
          options.portlessOrigin,
          options.portlessOrigin.startsWith("https:") ? "wss:" : "ws:",
        );
        const upgraded = bunServer.upgrade(request, {
          data: {
            activeHost,
            targetUrl: target.toString(),
            pending: [],
            upstreamOpen: false,
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }

      return proxyHttp(request, activeHost, options);
    },
    websocket: {
      open(ws) {
        const upstream = new WebSocket(ws.data.targetUrl);
        ws.data.upstream = upstream;
        upstream.addEventListener("open", () => {
          ws.data.upstreamOpen = true;
          for (const message of ws.data.pending.splice(0)) {
            sendToUpstream(upstream, message);
          }
        });
        upstream.addEventListener("message", (event) => {
          sendToClient(ws, event.data);
        });
        upstream.addEventListener("close", (event) => {
          ws.close(event.code || 1000, event.reason);
        });
        upstream.addEventListener("error", () => {
          ws.close(1011, `Upstream WebSocket failed for ${ws.data.activeHost}`);
        });
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (!upstream || !ws.data.upstreamOpen) {
          ws.data.pending.push(message);
          return;
        }
        sendToUpstream(upstream, message);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });

  console.log(`Diligent dev switchboard listening at http://${server.hostname}:${server.port}`);
  console.log(`Control UI: http://${server.hostname}:${server.port}/_dev`);
  console.log(`Portless origin: ${options.portlessOrigin}`);
  console.log(`State file: ${options.stateFile}`);
}

async function registerCommand(argv: string[]): Promise<void> {
  const options = parseRegisterOptions(argv);
  if (!options) {
    return;
  }

  const state = await readState(options.stateFile);
  const now = new Date().toISOString();
  const current = state.targets?.[options.host];
  const nextTarget: DevTarget = {
    host: options.host,
    cwd: options.cwd ?? current?.cwd,
    url: options.url ?? current?.url,
    updatedAt: now,
  };

  await writeState(options.stateFile, {
    ...state,
    activeHost: options.activate ? options.host : state.activeHost,
    updatedAt: options.activate ? now : state.updatedAt,
    targets: {
      ...(state.targets ?? {}),
      [options.host]: nextTarget,
    },
  });

  console.log(`${options.activate ? "Active" : "Registered"} dev target: ${options.host}`);
}

async function useCommand(argv: string[]): Promise<void> {
  const parsed = parseCommonCommandOptions(argv);
  if (!parsed) {
    return;
  }
  const [host] = parsed.positionals;
  if (!host) {
    throw new Error("Missing host: dev-switchboard use <portless-host>");
  }

  const activeHost = normalizeTargetHost(host);
  const state = await readState(parsed.options.stateFile);
  const now = new Date().toISOString();
  await writeState(parsed.options.stateFile, {
    ...state,
    activeHost,
    updatedAt: now,
    targets: {
      ...(state.targets ?? {}),
      [activeHost]: state.targets?.[activeHost] ?? { host: activeHost, updatedAt: now },
    },
  });
  console.log(`Active dev target: ${activeHost}`);
}

async function listCommand(argv: string[]): Promise<void> {
  const parsed = parseCommonCommandOptions(argv);
  if (!parsed) {
    return;
  }
  const state = await readState(parsed.options.stateFile);
  console.log(JSON.stringify({ activeHost: state.activeHost ?? null, targets: sortedTargets(state) }, null, 2));
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0]?.startsWith("-") || !argv[0] ? "start" : argv[0];
  const rest = command === "start" && argv[0]?.startsWith("-") ? argv : argv.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "register") {
    await registerCommand(rest);
    return;
  }
  if (command === "use") {
    await useCommand(rest);
    return;
  }
  if (command === "list") {
    await listCommand(rest);
    return;
  }
  if (command !== "start") {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseStartOptions(rest);
  if (options) {
    await startSwitchboard(options);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
