// @summary OVERDARE Studio product web-server runner that injects product-owned bundled tools.

// Sentry must be imported before everything else so error handlers hook first.
import "./sentry";

import { createLogger } from "@diligent/logging";
import { loadDiligentConfig, resolveExperimentStates } from "@diligent/runtime";
import { OVERDARE_EXPERIMENTS } from "./experiments";
import { configureSidecarLogging } from "./logging";
import {
  buildRegistries,
  type McpRegistries,
  resolveBootstrapDir,
  runMcpServerMain,
  toCatalogSnapshot,
} from "./mcp-server";
import { createRouterEndpoint } from "./router-endpoint";
import { createSidecarToken, type StudioRegistration, startStudioRegistration } from "./studio-registry";
import { createStudioBundledToolProviders } from "./tools";
import { type ConsentService, createGatewayConsentService } from "./tools/gateway/consent";
import { postUserFeedback } from "./tools/gateway/feedback";
import { resolveStudioHost, resolveStudioPort } from "./tools/studiorpc/config";
import { createWebServer, enableProcessLogFile, parseArgs } from "./web/server";

const logger = createLogger({ scope: "sidecar/server" });

function parseEnvPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createConsentMode(
  studioDisabled: boolean,
  createConsentService: () => ConsentService = createGatewayConsentService,
): { consentBackend?: ConsentService; canTransmitRecords: () => boolean } {
  const consentBackend = studioDisabled ? undefined : createConsentService();
  return {
    consentBackend,
    canTransmitRecords: () => consentBackend?.isGranted() ?? false,
  };
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

/**
 * Registers this sidecar in the Studio registry so `overdare-ai-agent start-mcp-router` can
 * discover and route to it (P071). Registration lands as soon as the port is known; the MCP catalog
 * follows in the background so building the tool registries never delays server startup — the
 * launcher parses `DILIGENT_PORT` under a timeout.
 *
 * Failures are logged and swallowed: the router is an additional surface, and a registry write that
 * fails (read-only home, exotic permissions) must not take down the Studio web server.
 */
async function registerForMcpRouter(options: {
  cwd: string;
  projectId?: string;
  hubEndpoint?: string;
  sidecarPort: number;
  sidecarToken: string;
  registries: () => Promise<McpRegistries>;
}): Promise<StudioRegistration | null> {
  let registration: StudioRegistration;
  try {
    registration = await startStudioRegistration({
      cwd: options.cwd,
      projectId: options.projectId,
      hubEndpoint: options.hubEndpoint,
      // Report the same host/port the Studio RPC tools actually dial, so the router's instance list
      // describes where calls really go rather than a guess.
      studioHost: resolveStudioHost(),
      studioPort: resolveStudioPort(),
      sidecarPort: options.sidecarPort,
      sidecarToken: options.sidecarToken,
    });
  } catch (error) {
    logger.warn("mcp_router.register_failed", {
      message: "[Studio Server] Could not register for the MCP router; `start-mcp-router` will not see this Studio.",
      error,
    });
    return null;
  }

  void options
    .registries()
    .then((registries) => registration.updateCatalog(toCatalogSnapshot(registries)))
    .catch((error) => {
      logger.warn("mcp_router.catalog_failed", {
        message: "[Studio Server] Could not publish the MCP tool catalog for the router.",
        error,
      });
    });

  return registration;
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
  const studioDisabled = process.env.STUDIO_DISABLED === "1" || process.env.STUDIO_DISABLED?.toLowerCase() === "true";
  const consentMode = createConsentMode(studioDisabled);

  // Built once, on first router request or catalog publish — never on the startup path.
  //
  // Experiments must be resolved here exactly as `mcp-serve` does (see runMcpServerMain): they gate
  // tools, skills, and agents, so skipping them would let the router advertise and execute a tool
  // the same build hides over stdio.
  let registriesPromise: Promise<McpRegistries> | undefined;
  const registries = (): Promise<McpRegistries> => {
    registriesPromise ??= (async () => {
      const { config } = await loadDiligentConfig(cwd);
      return buildRegistries({
        cwd,
        bootstrapDir: resolveBootstrapDir(),
        experiments: resolveExperimentStates(OVERDARE_EXPERIMENTS, config.experiments?.overrides),
      });
    })();
    return registriesPromise;
  };
  const sidecarToken = createSidecarToken();
  let registration: StudioRegistration | null = null;

  try {
    const { server } = await createWebServer({
      port: args.port,
      dev: args.dev,
      cwd,
      userId: args.userId,
      distDir: args.distDir,
      // AI-data consent is owned by the gateway (`/v1/consent`), not local config.jsonc.
      // UI-only development has no consent backend or gateway transmission.
      consentBackend: consentMode.consentBackend,
      feedbackBackend: {
        submit: (report) =>
          postUserFeedback({
            ...report,
            source: "overdare-ai-agent",
            version: process.env.OVERDARE_AI_AGENT_VERSION,
            projectId: process.env.OVERDARE_PROJECT_ID,
          }),
      },
      bundledToolProviders: createStudioBundledToolProviders({
        cwd,
        studioRpcPort: parseEnvPort(process.env.STUDIO_PORT),
        hubDomain: process.env.HUB_DOMAIN,
        projectId: process.env.OVERDARE_PROJECT_ID,
        canTransmitRecords: consentMode.canTransmitRecords,
        // STUDIO_DISABLED=1 → skip the Studio RPC provider entirely (no 13377 connects).
        studioDisabled,
      }),
      experimentDefinitions: OVERDARE_EXPERIMENTS,
      // STUDIO_DISABLED=1 is UI-only development with no Studio behind it, so there is nothing for
      // the router to route to — skip the endpoint (and the registration below) entirely.
      ...(studioDisabled ? {} : { extraRoutes: createRouterEndpoint({ token: sidecarToken, registries }) }),
    });

    const cleanup = () => {
      cleanupParentWatchdog?.();
      cleanupLogFile?.();
      // Drop the registry record so the router stops offering a Studio that is going away. The
      // heartbeat would expire it anyway; this makes a clean shutdown immediate.
      registration?.stop();
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

    // Without a port there is no address for the router to call back on, so registration would
    // publish an unroutable record.
    if (!studioDisabled && server.port) {
      registration = await registerForMcpRouter({
        cwd,
        projectId: process.env.OVERDARE_PROJECT_ID,
        hubEndpoint: process.env.HUB_DOMAIN,
        sidecarPort: server.port,
        sidecarToken,
        registries,
      });
    }

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
