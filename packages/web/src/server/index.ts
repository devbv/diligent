// @summary Bun server entrypoint for Web CLI with /rpc WebSocket, persisted image routes, and static file hosting
import { createWriteStream, existsSync, mkdirSync, realpathSync, type WriteStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type ConsoleLike, createConsoleSink, createLogger, type Logger } from "@diligent/logging";
import {
  type AgentRegistry,
  type BundledToolProvider,
  type ConsentConfigManager,
  createAppServerConfig,
  createWsPeer,
  DiligentAppServer,
  type DiligentPaths,
  type ExperimentDefinition,
  ensureDiligentDir,
  getModelInfoList,
  loadRuntimeConfig,
  type PROVIDER_NAMES,
  type RuntimeAgent,
  refreshPrivacyPolicyUrl,
  resolveConsentState,
} from "@diligent/runtime";
import { decodeWebImageRelativePath, toWebImageUrl, WEB_IMAGE_ROUTE_PREFIX } from "../shared/image-routes";

const logger = createLogger({ scope: "web.server" });

function createStreamLogger(
  scope: string,
  stdoutWrite: (value: string) => unknown,
  stderrWrite: (value: string) => unknown,
): Logger {
  const console: ConsoleLike = {
    debug: (value) => stdoutWrite(`${String(value)}\n`),
    info: (value) => stdoutWrite(`${String(value)}\n`),
    warn: (value) => stderrWrite(`${String(value)}\n`),
    error: (value) => stderrWrite(`${String(value)}\n`),
  };
  return createLogger({ scope, sink: createConsoleSink({ console }) });
}

interface WsData {
  connectionId: string;
}

interface CreateServerOptions {
  port?: number;
  dev?: boolean;
  cwd?: string;
  userId?: string;
  distDir?: string;
  bundledToolProviders?: BundledToolProvider[];
  experimentDefinitions?: ExperimentDefinition[];
  /** Remote-backed consent manager (e.g. OVERDARE gateway `/v1/consent`); overrides local config. */
  consentBackend?: ConsentConfigManager;
}

interface ParsedArgs {
  port?: number;
  dev: boolean;
  distDir?: string;
  cwd?: string;
  userId?: string;
  logFile?: string;
  parentPid?: number;
}

export function resolveServerVersionOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.DILIGENT_SERVER_VERSION?.trim();
  if (!value) return undefined;
  // Prefix the release channel so the UI reads "dev-v0.4.19" / "prod-v0.4.19",
  // matching the GitHub release tag naming (<env>-v<version>). The channel
  // mirrors plugin-sdk's currentEnv(): "dev" only when DILIGENT_ENV is exactly
  // "dev" (case-insensitive); everything else — including a legacy launcher
  // that never sets it — stays on "prod". Read from the same `env` arg (not
  // process.env) so the override stays unit-testable. Only real values get the
  // prefix: a bare version downstream means the launcher forwarded none and
  // server.ts fell back to its hardcoded default — keep that distinguishable.
  const channel = env.DILIGENT_ENV?.trim().toLowerCase() === "dev" ? "dev" : "prod";
  return `${channel}-v${value.replace(/^v/, "")}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startParentWatchdog(parentPid?: number): (() => void) | null {
  if (!parentPid || !Number.isFinite(parentPid) || parentPid <= 0) {
    return null;
  }

  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) {
      return;
    }

    logger.error("parent.exited", {
      message: `[Server] Parent process ${parentPid} is gone. Exiting sidecar.`,
      fields: { parentPid },
    });
    process.exit(0);
  }, 2000);

  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

export async function createWebServer(options: CreateServerOptions = {}): Promise<{
  server: Bun.Server<WsData>;
  stop: () => void;
}> {
  const cwd = options.cwd ?? process.cwd();
  const port = options.port ?? 7433;
  const dev = options.dev ?? false;

  const paths = await ensureDiligentDir(cwd);
  const bundledToolProviders = options.bundledToolProviders ?? [];
  const runtimeConfig = await loadRuntimeConfig(cwd, paths, {
    bundledToolProviders,
    experimentDefinitions: options.experimentDefinitions,
  });
  if (options.userId?.trim()) {
    runtimeConfig.diligent = {
      ...runtimeConfig.diligent,
      userId: options.userId.trim(),
    };
  }

  let lastRegistry: AgentRegistry | undefined;
  const threadAppServerLog = enableThreadAppServerLogFile(paths);

  const baseConfig = createAppServerConfig({
    cwd,
    runtimeConfig,
    bundledToolProviders,
    consentBackend: options.consentBackend,
    overrides: {
      onCurrentThreadChange: (threadId) => threadAppServerLog.setThreadId(threadId),
      serverVersion: resolveServerVersionOverride(),
      toImageUrl: (absPath) => toWebImageUrl(absPath),
      getInitializeResult: async () => {
        await refreshPrivacyPolicyUrl(); // resolve the versioned privacy-policy URL (3s-bounded, cached)
        await options.consentBackend?.refresh?.(); // re-sync remote-backed consent before the payload
        return {
          cwd,
          mode: runtimeConfig.mode,
          effort: runtimeConfig.effort,
          currentModel: runtimeConfig.model,
          availableModels: getModelInfoList().filter((m) =>
            runtimeConfig.providerManager
              .getConfiguredProviders()
              .includes(m.provider as (typeof PROVIDER_NAMES)[number]),
          ),
          skills: runtimeConfig.skills.map((s) => ({
            name: s.name,
            description: s.description,
          })),
          consent: options.consentBackend
            ? options.consentBackend.get()
            : resolveConsentState(runtimeConfig.diligent.consent),
        };
      },
    },
  });

  // Wrap createAgent to capture registry for shutdown
  const origCreate = baseConfig.createAgent;
  baseConfig.createAgent = async (args): Promise<RuntimeAgent> => {
    const agent = await origCreate(args);
    if (agent.registry) lastRegistry = agent.registry;
    return agent;
  };

  const appServer = new DiligentAppServer(baseConfig);

  // Map from connectionId → peer receive function, for routing WS messages
  const peerReceivers = new Map<string, (raw: string | Buffer) => void>();

  const distDir = options.distDir ?? resolveDistDir();
  const hasDist = existsSync(distDir);

  const server = Bun.serve<WsData>({
    port,
    // ponytail: bind loopback only — local browser access; avoids Windows Firewall prompt. Use 0.0.0.0 if LAN access is needed.
    hostname: "127.0.0.1",
    fetch(req, bunServer) {
      const url = new URL(req.url);

      if (url.pathname === "/rpc") {
        const connectionId = `web-${crypto.randomUUID().slice(0, 8)}`;
        const upgraded = bunServer.upgrade(req, { data: { connectionId } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (url.pathname.startsWith(WEB_IMAGE_ROUTE_PREFIX)) {
        const image = resolvePersistedImage(url.pathname, paths);
        if (!image) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(Bun.file(image.path), {
          headers: {
            "Content-Type": image.mediaType,
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (!dev && hasDist) {
        let filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
        if (!existsSync(filePath)) {
          filePath = join(distDir, "index.html");
        }

        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath));
        }
      }

      if (dev) {
        return new Response("Web server is running in --dev mode. Start Vite separately on :5174", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      // Raise the idle timeout well above the client heartbeat interval (25s) so a tab left
      // open on a long-running user-input prompt is not dropped. Durable server requests also
      // survive a disconnect and are re-delivered on resubscribe, but keeping the socket alive
      // avoids the churn entirely. 240s is within Bun's allowed maximum (255s).
      idleTimeout: 240,
      open(ws) {
        const { peer, receive } = createWsPeer(ws);
        peerReceivers.set(ws.data.connectionId, receive);
        appServer.connect(ws.data.connectionId, peer, { userId: runtimeConfig.diligent.userId });
      },
      message(ws, raw) {
        peerReceivers.get(ws.data.connectionId)?.(raw);
      },
      close(ws) {
        peerReceivers.delete(ws.data.connectionId);
        appServer.disconnect(ws.data.connectionId);
      },
    },
  });

  return {
    server,
    stop: () => {
      threadAppServerLog.cleanup();
      lastRegistry?.shutdownAll().catch(() => {});
      server.stop();
    },
  };
}

function resolveDistDir(): string {
  // Compiled binary: dist/client sits next to the binary executable
  const candidate = resolve(dirname(process.execPath), "dist", "client");
  if (existsSync(candidate)) return candidate;
  // Dev fallback: relative to source file
  return resolve(import.meta.dir, "../../dist/client");
}

function resolvePersistedImage(pathname: string, paths: DiligentPaths): { path: string; mediaType: string } | null {
  const relativePath = decodeWebImageRelativePath(pathname);
  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  const fullPath = resolve(paths.root, "images", ...segments);
  const imageRoot = resolve(paths.root, "images");
  const expectedPrefix = `${imageRoot}${sep}`;
  if (fullPath !== imageRoot && !fullPath.startsWith(expectedPrefix)) {
    return null;
  }
  if (!existsSync(fullPath)) {
    return null;
  }

  let resolvedPath: string;
  let resolvedRoot: string;
  try {
    resolvedPath = realpathSync(fullPath);
    resolvedRoot = realpathSync(imageRoot);
  } catch {
    return null;
  }

  const resolvedPrefix = `${resolvedRoot}${sep}`;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedPrefix)) {
    return null;
  }

  return {
    path: resolvedPath,
    mediaType: inferImageMediaType(resolvedPath),
  };
}

function inferImageMediaType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

export function enableProcessLogFile(logFile: string, baseDir: string): () => void {
  const resolvedPath = resolve(baseDir, logFile);
  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  const streamLogger = createStreamLogger("web.server.process-log", originalStdoutWrite, originalStderrWrite);

  let mirrorEnabled = true;
  let reportedStreamError = false;
  let stream: WriteStream | null = null;

  const ensureStream = (): WriteStream | null => {
    if (stream) {
      return stream;
    }
    try {
      mkdirSync(dirname(resolvedPath), { recursive: true });
      stream = createWriteStream(resolvedPath, { flags: "a" });
      stream.on("error", reportStreamError);
      return stream;
    } catch (error) {
      reportStreamError(error);
      return null;
    }
  };

  const reportStreamError = (error: unknown): void => {
    if (reportedStreamError) return;
    reportedStreamError = true;
    mirrorEnabled = false;
    streamLogger.error("log_file.write_failed", {
      message: `[webserver-log] Failed to write log file ${resolvedPath}`,
      error,
      fields: { path: resolvedPath },
    });
  };

  const mirrorWrite = (chunk: unknown, encoding?: unknown): void => {
    if (!mirrorEnabled) return;
    const activeStream = ensureStream();
    if (!activeStream) return;
    try {
      if (typeof chunk === "string") {
        if (typeof encoding === "string") {
          activeStream.write(chunk, encoding as BufferEncoding);
        } else {
          activeStream.write(chunk);
        }
        return;
      }
      if (chunk instanceof Uint8Array) {
        activeStream.write(chunk);
        return;
      }
      activeStream.write(String(chunk));
    } catch (error) {
      reportStreamError(error);
    }
  };

  process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    mirrorWrite(chunk, typeof encoding === "function" ? undefined : encoding);
    return originalStdoutWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    mirrorWrite(chunk, typeof encoding === "function" ? undefined : encoding);
    return originalStderrWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  streamLogger.info("mirroring.started", {
    message: `[webserver-log] Mirroring stdout/stderr to ${resolvedPath}`,
    fields: { path: resolvedPath },
  });

  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    stream?.end();
  };
}

export function enableThreadAppServerLogFile(paths: Pick<DiligentPaths, "root">): {
  setThreadId: (threadId: string) => void;
  cleanup: () => void;
} {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  const streamLogger = createStreamLogger("web.server.thread-log", originalStdoutWrite, originalStderrWrite);
  const pendingLines: string[] = [];

  let currentThreadId: string | null = null;
  let logsDirInitialized = false;
  let partialLine = "";

  const appendLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!currentThreadId) {
      pendingLines.push(trimmed);
      return;
    }

    const logsDir = join(paths.root, "logs");
    if (!logsDirInitialized) {
      mkdirSync(logsDir, { recursive: true });
      logsDirInitialized = true;
    }

    const logPath = join(logsDir, `${currentThreadId}.app-server.log`);
    appendFile(logPath, `${new Date().toISOString()} ${trimmed}\n`).catch((error) => {
      streamLogger.error("log_file.write_failed", {
        message: `[webserver-log] Failed to write app-server log file ${logPath}`,
        error,
        threadId: currentThreadId ?? undefined,
        fields: { path: logPath },
      });
    });
  };

  const mirrorChunk = (chunk: unknown): void => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
    partialLine += text;
    const lines = partialLine.split(/\r?\n/);
    partialLine = lines.pop() ?? "";
    for (const line of lines) appendLine(line);
  };

  process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    mirrorChunk(chunk);
    return originalStdoutWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    mirrorChunk(chunk);
    return originalStderrWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  const flushPending = (): void => {
    if (!currentThreadId) return;
    while (pendingLines.length > 0) {
      appendLine(pendingLines.shift() ?? "");
    }
  };

  return {
    setThreadId(threadId: string): void {
      currentThreadId = threadId;
      flushPending();
    },
    cleanup(): void {
      if (partialLine) {
        appendLine(partialLine);
        partialLine = "";
      }
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const portArg = argv.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number.parseInt(portArg.split("=")[1], 10) : undefined;
  const dev = argv.includes("--dev");
  const distArg = argv.find((arg) => arg.startsWith("--dist-dir="));
  const distDir = distArg ? distArg.split("=")[1] : undefined;
  const cwdArg = argv.find((arg) => arg.startsWith("--cwd="));
  const cwd = cwdArg ? cwdArg.split("=")[1] : undefined;
  const userIdArg = argv.find((arg) => arg.startsWith("--userid="));
  const userId = userIdArg ? userIdArg.slice("--userid=".length) : undefined;
  const logFileArg = argv.find((arg) => arg.startsWith("--log-file="));
  const logFile = logFileArg ? logFileArg.slice("--log-file=".length) : undefined;
  const parentPidArg = argv.find((arg) => arg.startsWith("--parent-pid="));
  const parentPid = parentPidArg ? Number.parseInt(parentPidArg.split("=")[1], 10) : undefined;
  return {
    port: Number.isFinite(port) ? port : undefined,
    dev,
    distDir,
    cwd,
    userId,
    logFile,
    parentPid: Number.isFinite(parentPid) ? parentPid : undefined,
  };
}

const isDirect = import.meta.main;

if (isDirect) {
  // Global safety net: plugins or internal code may throw uncaught errors or
  // unhandled promise rejections (e.g. Bun happy-eyeballs socket errors that
  // bypass user-level handlers).  Log and swallow — never crash the server.
  process.on("uncaughtException", (err) => {
    logger.error("process.uncaught_exception", {
      message: "[Server] Uncaught exception (swallowed to keep server alive):",
      error: err,
    });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandled_rejection", {
      message: "[Server] Unhandled promise rejection (swallowed to keep server alive):",
      error: reason,
    });
  });

  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    const serverCwd = args.cwd ?? cwd;
    const logFile = args.logFile ?? process.env.DILIGENT_WEB_LOG_FILE;
    const cleanupLogFile = logFile ? enableProcessLogFile(logFile, serverCwd) : null;
    const cleanupParentWatchdog = startParentWatchdog(args.parentPid);

    createWebServer({
      port: args.port,
      dev: args.dev,
      cwd: serverCwd,
      userId: args.userId,
      distDir: args.distDir,
    })
      .then(({ server }) => {
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

        console.info(`DILIGENT_PORT=${server.port}`);
        logger.info("server.ready", {
          message: `Diligent Web CLI server running at http://localhost:${server.port}`,
          fields: { port: server.port, url: `http://localhost:${server.port}` },
        });
        logger.info("rpc.ready", {
          message: `RPC endpoint: ws://localhost:${server.port}/rpc`,
          fields: { port: server.port, url: `ws://localhost:${server.port}/rpc` },
        });
      })
      .catch((error) => {
        cleanupParentWatchdog?.();
        cleanupLogFile?.();
        const message = error instanceof Error ? error.message : String(error);
        logger.error("startup.failed", {
          message: `Failed to start web server: ${message}`,
          error,
          fields: { port: args.port, cwd: serverCwd },
        });
        process.exit(1);
      });
  })();
}

export type { DiligentPaths };
export type { CreateServerOptions };
