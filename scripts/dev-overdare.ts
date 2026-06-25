#!/usr/bin/env bun
// @summary Friendly OVERDARE worktree dev workflow wrapper around Portless-managed Vite instances.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_LISTEN = "0.0.0.0:11000";
const DEFAULT_NAME = "diligent";

interface DevOverdareOptions {
  listen: string;
  stateFile?: string;
  lan: boolean;
  name: string;
  force: boolean;
  appPort?: string;
  tailscale: boolean;
  funnel: boolean;
  ngrok: boolean;
  instanceArgs: string[];
}

function printHelp(): void {
  console.log(`Usage:
  bun run dev:overdare [options] [-- <dev-instance-options>]
  bun run dev:overdare use <portless-host>
  bun run dev:overdare list

Common workflow:
  # Run this in each git worktree you want available.
  # The first one also starts the fixed Windows-facing switchboard.
  bun run dev:overdare

  # Optional terminal switching:
  bun run dev:overdare use fix-ui.diligent.localhost

Options:
  --listen <host:port>       Windows-facing address (default: ${DEFAULT_LISTEN})
  --state-file <path>        Switchboard state file
  --lan                      Ask Portless to run this instance in LAN mode
  --name <name>              Portless base app name (default: ${DEFAULT_NAME})
  --force                    Replace an existing Portless route
  --app-port <number>        Fixed app port for this instance
  --tailscale                Ask Portless to share over Tailscale
  --funnel                   Ask Portless to share over Tailscale Funnel
  --ngrok                    Ask Portless to share over ngrok
`);
}

function splitPassthrough(argv: string[]): { head: string[]; passthrough: string[] } {
  const marker = argv.indexOf("--");
  if (marker < 0) {
    return { head: argv, passthrough: [] };
  }
  return {
    head: argv.slice(0, marker),
    passthrough: argv.slice(marker + 1),
  };
}

function localBin(name: string): string | null {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const suffix of suffixes) {
    const candidate = resolve(ROOT, "node_modules", ".bin", `${name}${suffix}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function command(name: string): string {
  return localBin(name) ?? name;
}

function portlessCommand(args: string[]): string[] {
  return [command("portless"), ...args];
}

function spawnInherited(args: string[]): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(args, {
    cwd: ROOT,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function runInherited(args: string[]): Promise<never> {
  const child = spawnInherited(args);
  const code = await child.exited;
  process.exit(code ?? 1);
}

function runCaptured(args: string[]): string {
  const result = Bun.spawnSync(args, {
    cwd: ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(stderr || `Command failed: ${args.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

function parseOptions(argv: string[]): DevOverdareOptions | null {
  const { head, passthrough } = splitPassthrough(argv);
  const { values } = parseArgs({
    args: head,
    options: {
      listen: { type: "string" },
      "state-file": { type: "string" },
      lan: { type: "boolean" },
      name: { type: "string" },
      force: { type: "boolean" },
      "app-port": { type: "string" },
      tailscale: { type: "boolean" },
      funnel: { type: "boolean" },
      ngrok: { type: "boolean" },
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
    listen: values.listen?.trim() || DEFAULT_LISTEN,
    stateFile: values["state-file"]?.trim() || undefined,
    lan: values.lan === true,
    name: values.name?.trim() || DEFAULT_NAME,
    force: values.force === true,
    appPort: values["app-port"]?.trim() || undefined,
    tailscale: values.tailscale === true,
    funnel: values.funnel === true,
    ngrok: values.ngrok === true,
    instanceArgs: passthrough,
  };
}

function listenPort(listen: string): string {
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    return trimmed.slice(trimmed.lastIndexOf(":") + 1);
  }
  return "11000";
}

function resolvePortlessUrl(options: DevOverdareOptions): string {
  const output = runCaptured(portlessCommand(["get", options.name]));
  const urlText = output
    .split(/\r?\n/)
    .findLast((line) => line.trim().startsWith("http"))
    ?.trim();
  if (!urlText) {
    throw new Error(`Could not resolve Portless URL for ${options.name}`);
  }
  return urlText;
}

function hostFromUrl(urlText: string): string {
  try {
    return new URL(urlText).hostname.toLowerCase();
  } catch {
    throw new Error(`Portless returned an invalid URL: ${urlText}`);
  }
}

function buildSwitchboardStartArgs(options: DevOverdareOptions): string[] {
  return [
    "bun",
    "run",
    "dev:switchboard",
    "start",
    "--listen",
    options.listen,
    ...(options.stateFile ? ["--state-file", options.stateFile] : []),
  ];
}

async function isSwitchboardRunning(options: DevOverdareOptions): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${listenPort(options.listen)}/_dev/api/state`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForSwitchboard(options: DevOverdareOptions): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isSwitchboardRunning(options)) {
      return;
    }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for switchboard on port ${listenPort(options.listen)}`);
}

function buildInstanceArgs(options: DevOverdareOptions, targetHost: string): string[] {
  const portlessArgs = ["run", "--name", options.name];
  if (options.lan) {
    portlessArgs.push("--lan");
  }
  if (options.force) {
    portlessArgs.push("--force");
  }
  if (options.appPort) {
    portlessArgs.push("--app-port", options.appPort);
  }
  if (options.tailscale) {
    portlessArgs.push("--tailscale");
  }
  if (options.funnel) {
    portlessArgs.push("--funnel");
  }
  if (options.ngrok) {
    portlessArgs.push("--ngrok");
  }

  const instanceArgs = ["--switchboard-target", targetHost];
  if (options.stateFile) {
    instanceArgs.push("--switchboard-state-file", options.stateFile);
  }

  return portlessCommand([
    ...portlessArgs,
    "bun",
    "run",
    "dev:overdare-instance",
    ...instanceArgs,
    ...options.instanceArgs,
  ]);
}

async function autoCommand(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  if (!options) {
    return;
  }

  const portlessUrl = resolvePortlessUrl(options);
  const currentHost = hostFromUrl(portlessUrl);

  const switchboardWasRunning = await isSwitchboardRunning(options);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let stopping = false;

  const stopChildren = async (code: number): Promise<never> => {
    if (!stopping) {
      stopping = true;
      for (const child of children) {
        child.kill("SIGTERM");
      }
      await Promise.allSettled(children.map((child) => child.exited));
    }
    process.exit(code);
  };

  process.once("SIGINT", () => {
    void stopChildren(130);
  });
  process.once("SIGTERM", () => {
    void stopChildren(143);
  });

  if (!switchboardWasRunning) {
    console.log("[dev:overdare] starting switchboard");
    children.push(spawnInherited(buildSwitchboardStartArgs(options)));
    await waitForSwitchboard(options);
  } else {
    console.log("[dev:overdare] switchboard is already running");
  }

  console.log(`[dev:overdare] active target: ${currentHost}`);
  console.log("[dev:overdare] starting current worktree instance");
  children.push(spawnInherited(buildInstanceArgs(options, currentHost)));

  const firstExit = await Promise.race(
    children.map(async (child) => ({
      code: await child.exited,
    })),
  );
  await stopChildren(firstExit.code ?? 1);
}

async function switchboardCommand(commandName: "use" | "list", argv: string[]): Promise<void> {
  await runInherited(["bun", "run", "dev:switchboard", commandName, ...argv]);
}

async function run(): Promise<void> {
  const [commandName, ...rest] = process.argv.slice(2);
  if (!commandName) {
    await autoCommand([]);
    return;
  }
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp();
    return;
  }
  if (commandName.startsWith("-")) {
    await autoCommand(process.argv.slice(2));
    return;
  }
  if (commandName === "use" || commandName === "list") {
    await switchboardCommand(commandName, rest);
    return;
  }

  throw new Error(`Unknown dev:overdare command: ${commandName}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
