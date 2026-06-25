#!/usr/bin/env bun
// @summary Fixed-port development switchboard that proxies Windows traffic to the active Portless route.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_LISTEN = "0.0.0.0:11000";
const DEFAULT_PORTLESS_ORIGIN = "http://127.0.0.1:11001";
const DEFAULT_STATE_DIR = join(homedir(), ".diligent-dev-switchboard");
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, "state.json");
const DEFAULT_ROUTES_FILE = join(homedir(), ".portless", "routes.json");

interface SwitchboardState {
  activeHost?: string;
  updatedAt?: string;
}

interface ListenAddress {
  hostname: string;
  port: number;
}

interface CommonOptions {
  stateFile: string;
  routesFile: string;
}

interface StartOptions extends CommonOptions {
  listen: ListenAddress;
  portlessOrigin: string;
  defaultHost?: string;
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
  bun run scripts/dev-switchboard.ts use <portless-host> [options]
  bun run scripts/dev-switchboard.ts list [options]

Commands:
  start    Start the fixed-port proxy and GUI
  use      Switch the active Portless host
  list     Print active host and discovered route hosts

Start options:
  --listen <host:port>       Fixed Windows-facing address (default: ${DEFAULT_LISTEN})
  --portless <origin>        Portless proxy origin (default: ${DEFAULT_PORTLESS_ORIGIN})
  --default-host <host>      Fallback host when no active state exists

Common options:
  --state-file <path>        State file (default: ${DEFAULT_STATE_FILE})
  --routes-file <path>       Portless routes file (default: ${DEFAULT_ROUTES_FILE})
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
    const parsed = new URL(`http://${trimmed}`);
    return parsed.hostname.toLowerCase();
  }
}

function parseCommonOptions(values: Record<string, string | boolean | undefined>): CommonOptions {
  return {
    stateFile: resolve(process.cwd(), String(values["state-file"] || DEFAULT_STATE_FILE)),
    routesFile: resolve(process.cwd(), String(values["routes-file"] || DEFAULT_ROUTES_FILE)),
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
      "routes-file": { type: "string" },
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
      "routes-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return null;
  }

  return {
    options: parseCommonOptions(values),
    positionals,
  };
}

async function readState(stateFile: string): Promise<SwitchboardState> {
  if (!existsSync(stateFile)) {
    return {};
  }

  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as SwitchboardState;
  } catch {
    return {};
  }
}

async function writeState(stateFile: string, next: SwitchboardState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function addHostCandidate(hosts: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  const candidates = [trimmed];
  const urlMatches = trimmed.matchAll(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi);
  for (const match of urlMatches) {
    candidates.push(match[0]);
  }

  const hostMatches = trimmed.matchAll(/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?::\d+)?)\b/gi);
  for (const match of hostMatches) {
    candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    try {
      const host = normalizeTargetHost(candidate);
      if (!/^[0-9.]+$/.test(host) && host.includes(".")) {
        hosts.add(host);
      }
    } catch {
      // Ignore values that are not host-like.
    }
  }
}

function collectHosts(hosts: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    addHostCandidate(hosts, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectHosts(hosts, item);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      addHostCandidate(hosts, key);
      collectHosts(hosts, item);
    }
  }
}

async function readRouteHosts(routesFile: string): Promise<string[]> {
  if (!existsSync(routesFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(await readFile(routesFile, "utf8")) as unknown;
    const hosts = new Set<string>();
    collectHosts(hosts, parsed);
    return [...hosts].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function resolveActiveHost(options: StartOptions): Promise<string | null> {
  const state = await readState(options.stateFile);
  return state.activeHost ?? options.defaultHost ?? null;
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
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #15171a;
    }
    body {
      margin: 0;
      min-height: 100vh;
    }
    main {
      width: min(960px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid #d8dde6;
      padding-bottom: 20px;
    }
    h1 {
      font-size: 26px;
      line-height: 1.2;
      margin: 0;
    }
    .meta {
      color: #5d6673;
      font-size: 13px;
      line-height: 1.5;
      text-align: right;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 24px 0;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 38px;
      border: 1px solid #c7ced8;
      border-radius: 6px;
      padding: 0 11px;
      font: inherit;
      background: #ffffff;
      color: inherit;
    }
    button {
      height: 38px;
      border: 1px solid #b9c2cf;
      border-radius: 6px;
      background: #ffffff;
      color: #15171a;
      font: inherit;
      padding: 0 12px;
      cursor: pointer;
    }
    button.primary {
      background: #22577a;
      border-color: #22577a;
      color: #ffffff;
    }
    button:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .routes {
      display: grid;
      gap: 10px;
    }
    .route {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      border: 1px solid #d8dde6;
      border-radius: 8px;
      background: #ffffff;
      padding: 12px;
    }
    .host {
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 14px;
    }
    .active {
      border-color: #22577a;
      box-shadow: inset 3px 0 0 #22577a;
    }
    .empty {
      border: 1px dashed #c7ced8;
      border-radius: 8px;
      color: #5d6673;
      padding: 18px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        background: #101418;
        color: #eef2f6;
      }
      header,
      .route,
      .empty {
        border-color: #2a333d;
      }
      .route,
      input,
      button {
        background: #171d23;
        color: #eef2f6;
      }
      input,
      button {
        border-color: #36424f;
      }
      .meta,
      .empty {
        color: #a8b3c1;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Diligent Dev Switchboard</h1>
      <div class="meta">
        <div>Active: <span id="active">loading</span></div>
        <div>Portless: <span id="portless">loading</span></div>
      </div>
    </header>
    <form class="toolbar" id="manual-form">
      <input id="manual-host" autocomplete="off" spellcheck="false" placeholder="feature-name.diligent.localhost" />
      <button class="primary" type="submit">Use</button>
      <button type="button" id="refresh">Refresh</button>
    </form>
    <section class="routes" id="routes"></section>
  </main>
  <script>
    const activeEl = document.querySelector("#active");
    const portlessEl = document.querySelector("#portless");
    const routesEl = document.querySelector("#routes");
    const manualHost = document.querySelector("#manual-host");

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
      portlessEl.textContent = state.portlessOrigin;
      routesEl.innerHTML = "";

      if (!state.routes.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No Portless routes found.";
        routesEl.appendChild(empty);
        return;
      }

      for (const host of state.routes) {
        const row = document.createElement("div");
        row.className = "route" + (host === state.activeHost ? " active" : "");

        const label = document.createElement("div");
        label.className = "host";
        label.textContent = host;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = host === state.activeHost ? "Active" : "Use";
        button.disabled = host === state.activeHost;
        button.addEventListener("click", () => useHost(host));

        row.append(label, button);
        routesEl.appendChild(row);
      }
    }

    async function load() {
      const response = await fetch("/_dev/api/state", { cache: "no-store" });
      render(await response.json());
    }

    document.querySelector("#manual-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (manualHost.value.trim()) {
        useHost(manualHost.value.trim());
      }
    });
    document.querySelector("#refresh").addEventListener("click", load);
    load();
    setInterval(load, 3000);
  </script>
</body>
</html>`;
}

function buildTargetUrl(
  requestUrl: string,
  activeHost: string,
  portlessOrigin: string,
  protocol?: "http:" | "https:" | "ws:" | "wss:",
): URL {
  const incoming = new URL(requestUrl);
  const portless = new URL(portlessOrigin);
  const target = new URL(`${incoming.pathname}${incoming.search}`, portless);
  target.hostname = activeHost;
  target.protocol = protocol ?? portless.protocol;
  return target;
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function handleApiRequest(request: Request, url: URL, options: StartOptions): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/_dev") {
    return htmlResponse(renderGui());
  }

  if (request.method === "GET" && url.pathname === "/_dev/api/state") {
    const state = await readState(options.stateFile);
    const activeHost = state.activeHost ?? options.defaultHost;
    return jsonResponse({
      activeHost: activeHost ?? null,
      updatedAt: state.updatedAt ?? null,
      routes: await readRouteHosts(options.routesFile),
      portlessOrigin: options.portlessOrigin,
      stateFile: options.stateFile,
      routesFile: options.routesFile,
    });
  }

  if (request.method === "POST" && url.pathname === "/_dev/api/use") {
    let host: string | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { host?: string };
      host = body.host;
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      host = String(form.get("host") ?? "");
    } else {
      host = await request.text();
    }

    const activeHost = normalizeTargetHost(host ?? "");
    await writeState(options.stateFile, {
      activeHost,
      updatedAt: new Date().toISOString(),
    });
    return jsonResponse({ ok: true, activeHost });
  }

  if (url.pathname.startsWith("/_dev/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

async function proxyHttp(request: Request, activeHost: string, options: StartOptions): Promise<Response> {
  const target = buildTargetUrl(request.url, activeHost, options.portlessOrigin);
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
      const apiResponse = await handleApiRequest(request, url, options);
      if (apiResponse) {
        return apiResponse;
      }

      const activeHost = await resolveActiveHost(options);
      if (!activeHost) {
        return htmlResponse('<a href="/_dev">Choose an active dev target</a>', { status: 503 });
      }

      if (isWebSocketRequest(request)) {
        const targetUrl = buildTargetUrl(
          request.url,
          activeHost,
          options.portlessOrigin,
          options.portlessOrigin.startsWith("https:") ? "wss:" : "ws:",
        );
        const upgraded = bunServer.upgrade(request, {
          data: {
            activeHost,
            targetUrl: targetUrl.toString(),
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
  await writeState(parsed.options.stateFile, {
    activeHost,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Active dev target: ${activeHost}`);
}

async function listCommand(argv: string[]): Promise<void> {
  const parsed = parseCommonCommandOptions(argv);
  if (!parsed) {
    return;
  }
  const state = await readState(parsed.options.stateFile);
  const routes = await readRouteHosts(parsed.options.routesFile);
  console.log(JSON.stringify({ activeHost: state.activeHost ?? null, routes }, null, 2));
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0]?.startsWith("-") || !argv[0] ? "start" : argv[0];
  const rest = command === "start" && argv[0]?.startsWith("-") ? argv : argv.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
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
