#!/usr/bin/env bun
// @summary Friendly OVERDARE worktree dev workflow wrapper around Portless, switchboard, and instance startup.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_LISTEN = "0.0.0.0:11000";
const DEFAULT_PORTLESS_PORT = "11001";
const DEFAULT_DEFAULT_HOST = "diligent.localhost";

interface GatewayOptions {
  listen: string;
  portlessPort: string;
  portlessOrigin?: string;
  defaultHost: string;
  stateFile?: string;
  routesFile?: string;
  noProxyStart: boolean;
  lan: boolean;
}

interface InstanceOptions {
  name: string;
  force: boolean;
  appPort?: string;
  tailscale: boolean;
  funnel: boolean;
  ngrok: boolean;
  instanceArgs: string[];
}

interface AutoOptions {
  gateway: GatewayOptions;
  instance: InstanceOptions;
}

function printHelp(): void {
  console.log(`Usage:
  bun run dev:overdare [options] [-- <dev-instance-options>]
  bun run dev:overdare gateway [options]
  bun run dev:overdare instance [options] [-- <dev-instance-options>]
  bun run dev:overdare use <portless-host>
  bun run dev:overdare list

Common workflow:
  # Run this in each git worktree you want available.
  # The first one also starts the fixed Windows-facing gateway.
  bun run dev:overdare

  # Optional terminal switching:
  bun run dev:overdare use fix-ui.diligent.localhost

Gateway options:
  --listen <host:port>       Windows-facing address (default: ${DEFAULT_LISTEN})
  --portless-port <number>   Local Portless proxy port (default: ${DEFAULT_PORTLESS_PORT})
  --portless <origin>        Explicit Portless origin
  --default-host <host>      Initial active host (default: ${DEFAULT_DEFAULT_HOST})
  --state-file <path>        Switchboard state file
  --routes-file <path>       Portless routes file
  --no-proxy-start           Do not run "portless proxy start" first
  --lan                      Start Portless with LAN mode enabled

Instance options:
  --name <name>              Portless base app name (default: diligent)
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

function runChecked(args: string[]): void {
  const result = Bun.spawnSync(args, {
    cwd: ROOT,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

function parseGatewayOptions(argv: string[]): GatewayOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: "string" },
      "portless-port": { type: "string" },
      portless: { type: "string" },
      "default-host": { type: "string" },
      "state-file": { type: "string" },
      "routes-file": { type: "string" },
      "no-proxy-start": { type: "boolean" },
      lan: { type: "boolean" },
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
    portlessPort: values["portless-port"]?.trim() || DEFAULT_PORTLESS_PORT,
    portlessOrigin: values.portless?.trim() || undefined,
    defaultHost: values["default-host"]?.trim() || DEFAULT_DEFAULT_HOST,
    stateFile: values["state-file"]?.trim() || undefined,
    routesFile: values["routes-file"]?.trim() || undefined,
    noProxyStart: values["no-proxy-start"] === true,
    lan: values.lan === true,
  };
}

function parseInstanceOptions(argv: string[]): InstanceOptions | null {
  const { head, passthrough } = splitPassthrough(argv);
  const { values } = parseArgs({
    args: head,
    options: {
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
    name: values.name?.trim() || "diligent",
    force: values.force === true,
    appPort: values["app-port"]?.trim() || undefined,
    tailscale: values.tailscale === true,
    funnel: values.funnel === true,
    ngrok: values.ngrok === true,
    instanceArgs: passthrough,
  };
}

function startPortlessProxy(options: GatewayOptions): void {
  if (!options.noProxyStart) {
    const proxyArgs = ["proxy", "start", "--no-tls", "--port", options.portlessPort];
    if (options.lan) {
      proxyArgs.push("--lan");
    }
    runChecked(portlessCommand(proxyArgs));
  }
}

function buildSwitchboardArgs(options: GatewayOptions): string[] {
  const portlessOrigin = options.portlessOrigin ?? `http://127.0.0.1:${options.portlessPort}`;
  const switchboardArgs = [
    "run",
    "dev:switchboard",
    "start",
    "--listen",
    options.listen,
    "--portless",
    portlessOrigin,
    "--default-host",
    options.defaultHost,
  ];
  if (options.stateFile) {
    switchboardArgs.push("--state-file", options.stateFile);
  }
  if (options.routesFile) {
    switchboardArgs.push("--routes-file", options.routesFile);
  }
  return ["bun", ...switchboardArgs];
}

async function isSwitchboardRunning(options: GatewayOptions): Promise<boolean> {
  const port = options.listen.includes(":")
    ? options.listen.slice(options.listen.lastIndexOf(":") + 1)
    : options.listen;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_dev/api/state`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function gatewayCommand(argv: string[]): Promise<void> {
  const options = parseGatewayOptions(argv);
  if (!options) {
    return;
  }

  startPortlessProxy(options);
  await runInherited(buildSwitchboardArgs(options));
}

function buildInstanceArgs(options: InstanceOptions): string[] {
  const portlessArgs = ["run", "--name", options.name];
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

  return portlessCommand([...portlessArgs, "bun", "run", "dev:overdare-instance", ...options.instanceArgs]);
}

async function instanceCommand(argv: string[]): Promise<void> {
  const options = parseInstanceOptions(argv);
  if (!options) {
    return;
  }

  await runInherited(buildInstanceArgs(options));
}

async function switchboardCommand(commandName: "use" | "list", argv: string[]): Promise<void> {
  await runInherited(["bun", "run", "dev:switchboard", commandName, ...argv]);
}

function parseAutoOptions(argv: string[]): AutoOptions | null {
  const { head, passthrough } = splitPassthrough(argv);
  const { values } = parseArgs({
    args: head,
    options: {
      listen: { type: "string" },
      "portless-port": { type: "string" },
      portless: { type: "string" },
      "default-host": { type: "string" },
      "state-file": { type: "string" },
      "routes-file": { type: "string" },
      "no-proxy-start": { type: "boolean" },
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
    gateway: {
      listen: values.listen?.trim() || DEFAULT_LISTEN,
      portlessPort: values["portless-port"]?.trim() || DEFAULT_PORTLESS_PORT,
      portlessOrigin: values.portless?.trim() || undefined,
      defaultHost: values["default-host"]?.trim() || DEFAULT_DEFAULT_HOST,
      stateFile: values["state-file"]?.trim() || undefined,
      routesFile: values["routes-file"]?.trim() || undefined,
      noProxyStart: values["no-proxy-start"] === true,
      lan: values.lan === true,
    },
    instance: {
      name: values.name?.trim() || "diligent",
      force: values.force === true,
      appPort: values["app-port"]?.trim() || undefined,
      tailscale: values.tailscale === true,
      funnel: values.funnel === true,
      ngrok: values.ngrok === true,
      instanceArgs: passthrough,
    },
  };
}

async function autoCommand(argv: string[]): Promise<void> {
  const options = parseAutoOptions(argv);
  if (!options) {
    return;
  }

  startPortlessProxy(options.gateway);
  const switchboardWasRunning = await isSwitchboardRunning(options.gateway);
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
    console.log("[dev:overdare] starting switchboard gateway");
    children.push(spawnInherited(buildSwitchboardArgs(options.gateway)));
    await Bun.sleep(500);
  } else {
    console.log("[dev:overdare] switchboard gateway is already running");
  }

  console.log("[dev:overdare] starting current worktree instance");
  children.push(spawnInherited(buildInstanceArgs(options.instance)));

  const firstExit = await Promise.race(
    children.map(async (child) => ({
      code: await child.exited,
    })),
  );
  await stopChildren(firstExit.code ?? 1);
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

  if (commandName === "gateway") {
    await gatewayCommand(rest);
    return;
  }
  if (commandName === "instance") {
    await instanceCommand(rest);
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
