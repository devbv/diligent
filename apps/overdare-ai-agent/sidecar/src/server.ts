// @summary OVERDARE Studio product web-server runner that injects product-owned bundled tools.

import { createWebServer, enableProcessLogFile, parseArgs } from "@diligent/web/server";
import { runMcpServerMain } from "./mcp-server";
import { createStudioBundledToolProviders } from "./tools";
import { createGatewayConsentBackend } from "./tools/gateway/consent";

function parseEnvPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function startParentWatchdog(parentPid?: number): (() => void) | null {
  if (!parentPid || !Number.isFinite(parentPid) || parentPid <= 0) {
    return null;
  }

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.error(`[Studio Server] Parent process ${parentPid} is gone. Exiting sidecar.`);
      process.exit(0);
    }
  }, 2000);

  timer.unref?.();
  return () => clearInterval(timer);
}

export async function startStudioServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Guarantee the OVERDARE storage namespace even when launched directly (e.g. `bun run`
  // in dev) rather than via the Rust launcher, which always injects it (see
  // apps/overdare-ai-agent/src/storage.rs + webserver.rs). Without this, the generic
  // @diligent/runtime defaults to ".diligent" while this app's studio tools default to
  // ".overdare" — a split-brain in the same process. Only set when unset, so a
  // launcher-provided value (overdare / overdare-dev) still wins.
  process.env.DILIGENT_STORAGE_NAMESPACE ??= "overdare";

  const args = parseArgs(argv);
  const cwd = args.cwd ?? process.cwd();
  const logFile = args.logFile ?? process.env.DILIGENT_WEB_LOG_FILE;
  const cleanupLogFile = logFile ? enableProcessLogFile(logFile, cwd) : null;
  const cleanupParentWatchdog = startParentWatchdog(args.parentPid);

  try {
    const { server } = await createWebServer({
      port: args.port,
      dev: args.dev,
      cwd,
      userId: args.userId,
      distDir: args.distDir,
      // AI-data consent is owned by the gateway (`/v1/consent`), not local config.jsonc.
      consentBackend: createGatewayConsentBackend(),
      bundledToolProviders: createStudioBundledToolProviders({
        cwd,
        studioRpcPort: parseEnvPort(process.env.STUDIO_PORT),
        hubDomain: process.env.HUB_DOMAIN,
        projectId: process.env.OVERDARE_PROJECT_ID,
        // STUDIO_DISABLED=1 → skip the Studio RPC provider entirely (no 13377 connects).
        studioDisabled: process.env.STUDIO_DISABLED === "1" || process.env.STUDIO_DISABLED?.toLowerCase() === "true",
      }),
    });

    const cleanup = () => {
      cleanupParentWatchdog?.();
      cleanupLogFile?.();
    };

    process.once("exit", cleanup);
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });

    console.log(`DILIGENT_PORT=${server.port}`);
    console.log(`Diligent Web CLI server running at http://localhost:${server.port}`);
    console.log(`RPC endpoint: ws://localhost:${server.port}/rpc`);
  } catch (error) {
    cleanupParentWatchdog?.();
    cleanupLogFile?.();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start studio web server: ${message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  // `diligent-web-server mcp-serve` re-exposes OVERDARE studio tools + bootstrap prompts to
  // any MCP client over stdio, sharing this same binary/bundle (no separate artifact).
  if (process.argv[2] === "mcp-serve") {
    await runMcpServerMain();
  } else {
    process.on("uncaughtException", (err) => {
      console.error("[Studio Server] Uncaught exception (swallowed to keep server alive):", err?.message ?? err);
    });
    process.on("unhandledRejection", (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error("[Studio Server] Unhandled promise rejection (swallowed to keep server alive):", message);
    });

    await startStudioServer();
  }
}
