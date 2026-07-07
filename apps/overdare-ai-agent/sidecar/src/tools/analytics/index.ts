// @summary Overdare analytics plugin — sends session usage to Bubo via onStop hook

import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { cpus, homedir, release, totalmem, type } from "node:os";
import { basename, join } from "node:path";
import readline from "node:readline";
import type { BundledToolProvider, HookInput, PluginHookFn } from "@diligent/runtime";

const DEFAULT_BUBO_HOST = "https://bubo.overdare.com";
const DEV_BUBO_HOST = "https://bubo-dev.ovdr.io";
const STAGING_BUBO_HOST = "https://bubo-staging.overdare.com";
const STUDIO_LOG_ENDPOINT = "/studio-log";
const DEFAULT_STUDIO_RPC_HOST = "localhost";
const DEFAULT_STUDIO_RPC_PORT = 13377;
const STUDIO_RPC_TIMEOUT_MS = 5_000;
const DEFAULT_STORAGE_NAMESPACE = "diligent";
const PACKAGED_STORAGE_NAMESPACE = "overdare";

// ── Config ───────────────────────────────────────────────────────────────────

interface OverdareConfig {
  analytics?: {
    endpoint?: string;
  };
  bubo?: {
    endpoint?: string;
  };
  host?: string;
  port?: number;
}

interface StudioLogPayload {
  account_id: string;
  device: {
    os: string;
    os_version: string;
    platform: string;
    cpu: string;
    gpu: string;
    ram: string;
  };
  events: Array<{
    event_name: string;
    ts: number;
    values: Record<string, unknown>;
  }>;
  studio_info: {
    group_id: string;
    project_id: string;
    studio_version: string;
    world_id: string;
  };
  tags: Record<string, unknown>;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldSkipAnalyticsSend(): boolean {
  const allowInTest = isTruthy(process.env.DILIGENT_ANALYTICS_ALLOW_IN_TEST);
  if (allowInTest) return false;

  const isTestEnv = process.env.NODE_ENV === "test";
  const isCiEnv = isTruthy(process.env.CI);
  return isTestEnv || isCiEnv;
}

function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "");
        i += 2;
      } else if (text[i] === '"') {
        result += text[i++];
        inString = false;
      } else {
        result += text[i++];
      }
    } else if (text[i] === '"') {
      result += text[i++];
      inString = true;
    } else if (text[i] === "/" && text[i + 1] === "/") {
      // Line comment — skip to end of line
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      // Block comment — skip to closing */
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += text[i++];
    }
  }

  return result;
}

let cached: OverdareConfig | undefined;

function storageNamespace(): string {
  const value = process.env.DILIGENT_STORAGE_NAMESPACE?.trim();
  return value || PACKAGED_STORAGE_NAMESPACE;
}

function resolveHomeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? homedir();
}

function configCandidates(): string[] {
  const home = resolveHomeDir();
  const currentPath = join(home, `.${storageNamespace()}`, "overdare.jsonc");
  const legacyPath = join(home, `.${DEFAULT_STORAGE_NAMESPACE}`, "overdare.jsonc");
  return currentPath === legacyPath ? [currentPath] : [currentPath, legacyPath];
}

export function loadOverdareConfig(): OverdareConfig {
  if (cached) return cached;
  for (const configPath of configCandidates()) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, "utf-8");
      cached = JSON.parse(stripJsonComments(raw)) as OverdareConfig;
      return cached;
    } catch {
      cached = {};
      return cached;
    }
  }
  cached = {};
  return cached;
}

// ── Studio RPC auth ───────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface HubTokenReadResult {
  token?: string;
}

let nextRpcId = 1;
let cachedHubToken: string | undefined;

function resolveStudioRpcHost(config: OverdareConfig): string {
  return process.env.STUDIO_HOST ?? config.host ?? DEFAULT_STUDIO_RPC_HOST;
}

function resolveStudioRpcPort(config: OverdareConfig): number {
  const envPort = process.env.STUDIO_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return config.port ?? DEFAULT_STUDIO_RPC_PORT;
}

async function callStudioRpc(
  method: string,
  params: Record<string, unknown>,
  config: OverdareConfig,
): Promise<unknown> {
  const host = resolveStudioRpcHost(config);
  const port = resolveStudioRpcPort(config);

  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(Object.keys(params).length > 0 && { params }),
    };

    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      fn();
    }

    const connectHost = host === "localhost" ? "127.0.0.1" : host;
    const socket = net.createConnection({ host: connectHost, port }, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    const rl = readline.createInterface({ input: socket });

    const timer = setTimeout(() => {
      settle(() => {
        cleanup();
        reject(new Error(`Studio RPC timed out (${method})`));
      });
    }, STUDIO_RPC_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      rl.close();
      socket.destroy();
    }

    rl.once("line", (line) => {
      settle(() => {
        cleanup();
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          if (response.error) {
            reject(new Error(`Studio RPC error [${response.error.code}]: ${response.error.message}`));
          } else {
            resolve(response.result);
          }
        } catch {
          reject(new Error(`Failed to parse Studio RPC response: ${line.slice(0, 200)}`));
        }
      });
    });

    socket.on("error", () => {
      settle(() => {
        cleanup();
        reject(new Error("Could not connect to Studio RPC server"));
      });
    });
  });
}

/** Read the Creator Hub bearer token via Studio RPC (shared with the gateway transmitter). Cached. */
export async function readHubToken(config: OverdareConfig): Promise<string> {
  if (cachedHubToken) return cachedHubToken;

  const result = (await callStudioRpc("hub.token.read", {}, config)) as HubTokenReadResult | string | undefined;
  if (typeof result === "string" && result.length > 0) {
    cachedHubToken = result;
    return result;
  }
  if (result && typeof result === "object" && typeof result.token === "string" && result.token.length > 0) {
    cachedHubToken = result.token;
    return result.token;
  }
  throw new Error("Hub auth token is not available");
}

// ── Bubo ──────────────────────────────────────────────────────────────────────

function resolveBuboEndpoint(config: OverdareConfig): string {
  const explicitEndpoint = config.bubo?.endpoint ?? config.analytics?.endpoint ?? process.env.DILIGENT_ANALYTICS_URL;
  if (explicitEndpoint) return explicitEndpoint;

  const host = resolveDefaultBuboHost();
  return `${host.replace(/\/+$/, "")}${STUDIO_LOG_ENDPOINT}`;
}

function resolveDefaultBuboHost(): string {
  const hubDomain = normalizeHubDomain(process.env.HUB_DOMAIN);
  if (hubDomain === "https://create.overdare.com") return DEFAULT_BUBO_HOST;
  if (hubDomain === "https://release-qa.overdare.com") return STAGING_BUBO_HOST;
  return DEV_BUBO_HOST;
}

function normalizeHubDomain(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

function buildDeviceInfo(): StudioLogPayload["device"] {
  const [cpu] = cpus();
  return {
    os: type(),
    os_version: release(),
    platform: process.platform,
    cpu: cpu?.model ?? "",
    gpu: "",
    ram: String(totalmem()),
  };
}

function resolveProjectId(): string {
  return process.env.OVERDARE_PROJECT_ID?.trim() ?? "";
}

function readTokenUsage(input: HookInput): TokenUsage | undefined {
  const usage = input.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = typeof record.inputTokens === "number" ? record.inputTokens : 0;
  const outputTokens = typeof record.outputTokens === "number" ? record.outputTokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: typeof record.cacheReadTokens === "number" ? record.cacheReadTokens : undefined,
    cacheWriteTokens: typeof record.cacheWriteTokens === "number" ? record.cacheWriteTokens : undefined,
  };
}

function buildStudioLogPayload(input: HookInput): StudioLogPayload | undefined {
  const usage = readTokenUsage(input);
  if (!usage) return undefined;

  return {
    account_id: typeof input.user_id === "string" ? input.user_id : "unknown",
    device: buildDeviceInfo(),
    events: [
      {
        event_name: "agent_token_usage",
        ts: Date.now(),
        values: {
          cwd: basename(input.cwd ?? ""),
          session_id: input.session_id ?? "",
          model: input.model ?? "unknown",
          provider: input.provider ?? "unknown",
          ...(typeof input.provider_plan_type === "string" && input.provider_plan_type.length > 0
            ? { provider_plan_type: input.provider_plan_type }
            : {}),
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens ?? 0,
          cache_write_tokens: usage.cacheWriteTokens ?? 0,
        },
      },
    ],
    studio_info: {
      group_id: "",
      project_id: resolveProjectId(),
      studio_version: "",
      world_id: "",
    },
    tags: {},
  };
}

async function sendStudioLog(config: OverdareConfig, payload: StudioLogPayload): Promise<void> {
  const token = await readHubToken(config);
  const endpoint = resolveBuboEndpoint(config);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Bubo studio log failed with HTTP ${response.status}`);
  }
}

// ── Bundled provider ─────────────────────────────────────────────────────────

export function createAnalyticsToolProvider(): BundledToolProvider {
  return {
    id: "@overdare/analytics-hooks",
    displayName: "OVERDARE Analytics Hooks",
    supersedesPluginPackages: ["@overdare/plugin-analytics"],
    createTools: () => [],
    onStop,
  };
}

export const onStop: PluginHookFn = async (input: HookInput): Promise<Record<string, unknown>> => {
  if (shouldSkipAnalyticsSend()) return {};

  const config = loadOverdareConfig();
  const payload = buildStudioLogPayload(input);
  if (!payload) return {};

  // Fire-and-forget — don't await so the agent turn isn't blocked
  sendStudioLog(config, payload).catch(() => {});

  return {};
};

onStop.mode = "async";
