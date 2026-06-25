#!/usr/bin/env bun
// @summary Starts one OVERDARE sidecar plus Vite web dev instance for Portless/worktree routing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ENV_FILE = resolve(ROOT, ".env.overdare.local");
const DEFAULT_SIDECAR_ENTRY = resolve(ROOT, "apps/overdare-ai-agent/sidecar/src/server.ts");
const DEFAULT_WEB_CWD = resolve(ROOT, "packages/web");
const DEFAULT_BACKEND_PORT_START = 7433;
const DEFAULT_BACKEND_PORT_END = 7599;
const DEFAULT_WEB_PORT = 5174;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;

type EnvMap = Record<string, string>;
type ManagedProcess = ReturnType<typeof Bun.spawn>;

interface CliOptions {
  projectCwd?: string;
  envFile: string;
  backendPort?: number;
  webPort?: number;
  host?: string;
  sidecarEntry: string;
  webCwd: string;
  skipHealthWait: boolean;
  healthTimeoutMs: number;
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/dev-overdare-instance.ts [options]

Starts the OVERDARE sidecar backend and the web Vite dev server as one dev
instance. Use it under portless so each git worktree gets a stable host.

Options:
  --project-cwd <path>       OVERDARE project cwd passed to the sidecar
  --env-file <path>          Env file for OVERDARE/STUDIO secrets (default: .env.overdare.local)
  --backend-port <number>    Sidecar port (default: first free port from 7433)
  --web-port <number>        Vite port (default: $PORT from portless, then 5174)
  --host <host>              Vite host (default: $HOST, then 0.0.0.0)
  --sidecar-entry <path>     Sidecar entrypoint
  --web-cwd <path>           Web package cwd
  --skip-health-wait         Start Vite without waiting for backend /health
  --health-timeout-ms <ms>   Backend health wait timeout (default: 15000)
  --help                     Show this help

Required configuration:
  --project-cwd or OVERDARE_PROJECT_CWD must be set.
`);
}

function parsePort(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer: ${value}`);
  }
  return parsed;
}

function parseCliOptions(argv: string[]): CliOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      "project-cwd": { type: "string" },
      "env-file": { type: "string" },
      "backend-port": { type: "string" },
      "web-port": { type: "string" },
      host: { type: "string" },
      "sidecar-entry": { type: "string" },
      "web-cwd": { type: "string" },
      "skip-health-wait": { type: "boolean" },
      "health-timeout-ms": { type: "string" },
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
    projectCwd: values["project-cwd"]?.trim() || undefined,
    envFile: resolve(process.cwd(), values["env-file"]?.trim() || DEFAULT_ENV_FILE),
    backendPort: parsePort(values["backend-port"], "--backend-port"),
    webPort: parsePort(values["web-port"], "--web-port"),
    host: values.host?.trim() || undefined,
    sidecarEntry: resolve(process.cwd(), values["sidecar-entry"]?.trim() || DEFAULT_SIDECAR_ENTRY),
    webCwd: resolve(process.cwd(), values["web-cwd"]?.trim() || DEFAULT_WEB_CWD),
    skipHealthWait: values["skip-health-wait"] === true,
    healthTimeoutMs: parsePositiveInt(values["health-timeout-ms"], "--health-timeout-ms") ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

async function loadEnvFile(filePath: string): Promise<EnvMap> {
  if (!existsSync(filePath)) {
    return {};
  }

  const text = await readFile(filePath, "utf8");
  const env: EnvMap = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry) {
      env[entry[0]] = entry[1];
    }
  }
  return env;
}

function mergeEnv(fileEnv: EnvMap): EnvMap {
  const env: EnvMap = { ...fileEnv };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.DILIGENT_STORAGE_NAMESPACE ??= "overdare";
  env.DILIGENT_ENV ??= "prod";
  return env;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No free backend port found in range ${start}-${end}`);
}

async function waitForBackendHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the backend is ready or the timeout expires.
    }
    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for sidecar backend health at ${url}`);
}

function spawnManaged(name: string, command: string[], cwd: string, env: EnvMap): ManagedProcess {
  console.log(`[${name}] ${command.join(" ")}`);
  return Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function run(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options) {
    return;
  }

  const fileEnv = await loadEnvFile(options.envFile);
  const env = mergeEnv(fileEnv);
  const projectCwd = options.projectCwd ?? env.OVERDARE_PROJECT_CWD;
  if (!projectCwd?.trim()) {
    throw new Error("Missing --project-cwd or OVERDARE_PROJECT_CWD");
  }

  const backendPort =
    options.backendPort ??
    parsePort(env.DILIGENT_WEB_SERVER_PORT, "DILIGENT_WEB_SERVER_PORT") ??
    (await findFreePort(DEFAULT_BACKEND_PORT_START, DEFAULT_BACKEND_PORT_END));
  const webPort = options.webPort ?? parsePort(env.PORT, "PORT") ?? DEFAULT_WEB_PORT;
  const host = options.host ?? env.HOST ?? "0.0.0.0";

  env.DILIGENT_WEB_SERVER_PORT = String(backendPort);
  env.DILIGENT_WEB_RPC_TARGET = `ws://127.0.0.1:${backendPort}`;
  env.VITE_DILIGENT_RPC_URL = `ws://127.0.0.1:${backendPort}/rpc`;

  console.log(`[dev-instance] project cwd: ${projectCwd}`);
  console.log(`[dev-instance] backend: http://127.0.0.1:${backendPort}`);
  console.log(`[dev-instance] web: http://${host}:${webPort}`);

  const children: ManagedProcess[] = [];
  let stopping = false;

  const stopAndExit = async (code: number): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const child of children) {
      child.kill("SIGTERM");
    }
    await Promise.allSettled(children.map((child) => child.exited));
    process.exit(code);
  };

  process.once("SIGINT", () => {
    void stopAndExit(130);
  });
  process.once("SIGTERM", () => {
    void stopAndExit(143);
  });

  const sidecar = spawnManaged(
    "sidecar",
    ["bun", "run", options.sidecarEntry, "--dev", `--port=${backendPort}`, `--cwd=${resolve(projectCwd)}`],
    ROOT,
    env,
  );
  children.push(sidecar);

  if (!options.skipHealthWait) {
    try {
      await waitForBackendHealth(backendPort, options.healthTimeoutMs);
    } catch (error) {
      sidecar.kill("SIGTERM");
      await sidecar.exited.catch(() => 1);
      throw error;
    }
  }

  const web = spawnManaged(
    "web",
    ["bun", "run", "--cwd", options.webCwd, "dev", "--host", host, "--port", String(webPort)],
    ROOT,
    env,
  );
  children.push(web);

  const exited = await Promise.race(
    children.map(async (child, index) => ({
      index,
      code: await child.exited,
    })),
  );
  await stopAndExit(exited.code ?? 1);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
