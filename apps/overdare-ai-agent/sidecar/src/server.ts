// @summary OVERDARE Studio product web-server runner that injects product-owned bundled tools.

import { createLogger } from "@diligent/logging";
import { createWebServer, enableProcessLogFile, parseArgs } from "@diligent/web/server";
import { OVERDARE_EXPERIMENTS } from "./experiments";
import { configureSidecarLogging } from "./logging";
import { runMcpServerMain } from "./mcp-server";
import { createStudioBundledToolProviders } from "./tools";
import { createGatewayConsentService } from "./tools/gateway/consent";

const logger = createLogger({ scope: "sidecar/server" });

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
      logger.error("parent.exited", {
        message: `[Studio Server] Parent process ${parentPid} is gone. Exiting sidecar.`,
        fields: { parentPid },
      });
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
  const consentService = createGatewayConsentService();

  try {
    const { server } = await createWebServer({
      port: args.port,
      dev: args.dev,
      cwd,
      userId: args.userId,
      distDir: args.distDir,
      // AI-data consent is owned by the gateway (`/v1/consent`), not local config.jsonc.
      consentBackend: consentService,
      bundledToolProviders: createStudioBundledToolProviders({
        cwd,
        studioRpcPort: parseEnvPort(process.env.STUDIO_PORT),
        hubDomain: process.env.HUB_DOMAIN,
        projectId: process.env.OVERDARE_PROJECT_ID,
        canTransmitRecords: () => consentService.isGranted(),
        // STUDIO_DISABLED=1 → skip the Studio RPC provider entirely (no 13377 connects).
        studioDisabled: process.env.STUDIO_DISABLED === "1" || process.env.STUDIO_DISABLED?.toLowerCase() === "true",
      }),
      experimentDefinitions: OVERDARE_EXPERIMENTS,
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

    // Launcher contract: this exact, undecorated stdout line is machine-parsed by the Rust host.
    console.info(`DILIGENT_PORT=${server.port}`);
    logger.info("server.ready", {
      message: `Diligent Web CLI server running at http://localhost:${server.port}`,
      fields: { port: server.port },
    });
    logger.info("rpc.ready", {
      message: `RPC endpoint: ws://localhost:${server.port}/rpc`,
      fields: { port: server.port },
    });
  } catch (error) {
    cleanupParentWatchdog?.();
    cleanupLogFile?.();
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup.failed", {
      message: `Failed to start studio web server: ${message}`,
      error,
    });
    process.exit(1);
  }
}

if (import.meta.main) {
  // `diligent-web-server mcp-serve` re-exposes OVERDARE studio tools + bootstrap prompts to
  // any MCP client over stdio, sharing this same binary/bundle (no separate artifact).
  // Match the subcommand by presence rather than a fixed argv index: `bun run server.ts
  // mcp-serve` puts it at argv[2] (argv[1] is the script), but the compiled standalone binary
  // has no script entry so `diligent-web-server mcp-serve` lands it at argv[1]. A fixed index
  // silently fell through to the web server in the packaged build.
  if (process.argv.slice(1).includes("mcp-serve")) {
    await runMcpServerMain();
  } else {
    const startupArgs = parseArgs(process.argv.slice(2));
    configureSidecarLogging({
      source: "overdare-ai-agent",
      component: "sidecar/server",
      version: process.env.OVERDARE_AI_AGENT_VERSION,
      projectId: process.env.OVERDARE_PROJECT_ID,
      userId: startupArgs.userId,
    });

    process.on("uncaughtException", (err) => {
      logger.error("process.uncaught_exception", {
        message: `[Studio Server] Uncaught exception (swallowed to keep server alive): ${err?.message ?? err}`,
        error: err,
      });
    });
    process.on("unhandledRejection", (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error("process.unhandled_rejection", {
        message: `[Studio Server] Unhandled promise rejection (swallowed to keep server alive): ${message}`,
        error: reason,
      });
    });

    await startStudioServer();
  }
}
