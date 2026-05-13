// @summary Bun server entrypoint for Web CLI with /rpc WebSocket, persisted image routes, and static file hosting
import { createWriteStream, existsSync, mkdirSync, realpathSync, type WriteStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AgentRegistry,
  createAppServerConfig,
  createWsPeer,
  DiligentAppServer,
  type DiligentPaths,
  ensureDiligentDir,
  getModelInfoList,
  loadRuntimeConfig,
  type PROVIDER_NAMES,
  type RuntimeAgent,
} from "@diligent/runtime";
import { decodeWebImageRelativePath, toWebImageUrl, WEB_IMAGE_ROUTE_PREFIX } from "../shared/image-routes";

interface WsData {
  connectionId: string;
}

interface CreateServerOptions {
  port?: number;
  dev?: boolean;
  cwd?: string;
  userId?: string;
  distDir?: string;
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
  return value ? value : undefined;
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

    console.error(`[Server] Parent process ${parentPid} is gone. Exiting sidecar.`);
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
  const runtimeConfig = await loadRuntimeConfig(cwd, paths);
  if (options.userId?.trim()) {
    runtimeConfig.diligent = {
      ...runtimeConfig.diligent,
      userId: options.userId.trim(),
    };
  }

  let lastRegistry: AgentRegistry | undefined;

  const baseConfig = createAppServerConfig({
    cwd,
    runtimeConfig,
    overrides: {
      serverVersion: resolveServerVersionOverride(),
      toImageUrl: (absPath) => toWebImageUrl(absPath),
      getInitializeResult: async () => ({
        cwd,
        mode: runtimeConfig.mode,
        effort: runtimeConfig.effort,
        currentModel: runtimeConfig.model?.id,
        availableModels: getModelInfoList().filter((m) =>
          runtimeConfig.providerManager
            .getConfiguredProviders()
            .includes(m.provider as (typeof PROVIDER_NAMES)[number]),
        ),
        skills: runtimeConfig.skills.map((s) => ({
          name: s.name,
          description: s.description,
        })),
      }),
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
    const message = error instanceof Error ? error.message : String(error);
    originalStderrWrite(`[webserver-log] Failed to write log file ${resolvedPath}: ${message}\n`);
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

  originalStdoutWrite(`[webserver-log] Mirroring stdout/stderr to ${resolvedPath}\n`);

  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    stream?.end();
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
    console.error("[Server] Uncaught exception (swallowed to keep server alive):", err?.message ?? err);
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error("[Server] Unhandled promise rejection (swallowed to keep server alive):", message);
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

        console.log(`DILIGENT_PORT=${server.port}`);
        console.log(`Diligent Web CLI server running at http://localhost:${server.port}`);
        console.log(`RPC endpoint: ws://localhost:${server.port}/rpc`);
      })
      .catch((error) => {
        cleanupParentWatchdog?.();
        cleanupLogFile?.();
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start web server: ${message}`);
        process.exit(1);
      });
  })();
}

export type { DiligentPaths };
