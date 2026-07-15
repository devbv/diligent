import { createLogger } from "@diligent/logging";
import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { createApiHandler } from "./api.js";
import { findDiligentDir } from "./find-diligent-dir.js";
import { extractSessionMeta, parseSessionFile } from "./parser.js";
import { SessionWatcher } from "./watcher.js";
import { WebSocketManager, type WsData } from "./websocket.js";

const logger = createLogger({
  scope: "debug-viewer",
  context: { component: "server" },
});

// Parse CLI args
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = portArg
  ? Number.parseInt(portArg, 10)
  : args.includes("--port")
    ? Number.parseInt(args[args.indexOf("--port") + 1], 10)
    : 7432;
const dev = args.includes("--dev");
const dirArg =
  args.find((a) => a.startsWith("--dir="))?.split("=")[1] ??
  (args.includes("--dir")
    ? args[args.indexOf("--dir") + 1]
    : (args.find((a) => a.startsWith("--data-dir="))?.split("=")[1] ??
      (args.includes("--data-dir") ? args[args.indexOf("--data-dir") + 1] : null)));

function resolveDefaultDiligentDir(): string | null {
  const discovered = findDiligentDir({ cwd: process.cwd() });
  if (discovered) return discovered;

  const candidate = join(dirname(process.execPath), ".diligent");
  return existsSync(candidate) ? candidate : null;
}

function normalizeDataDirCandidate(candidatePath: string): string {
  if (candidatePath.endsWith(".diligent")) return candidatePath;
  const nested = join(candidatePath, ".diligent");
  if (existsSync(nested)) return nested;
  return candidatePath;
}

function resolveStaticClientDir(): string | null {
  const candidates = [
    resolve(import.meta.dir, "../../dist/client"),
    join(dirname(process.execPath), "client"),
    resolve(process.cwd(), "packages/debug-viewer/dist/client"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// Find data directory
const dataDir = dirArg
  ? isAbsolute(dirArg)
    ? normalizeDataDirCandidate(dirArg)
    : normalizeDataDirCandidate(resolve(process.cwd(), dirArg))
  : resolveDefaultDiligentDir();
if (!dataDir) {
  console.error("Could not find .diligent/ directory. Run from a diligent project, or pass --dir <path>.");
  process.exit(1);
}

console.log(`Data directory: ${dataDir}`);

const handleApi = createApiHandler(dataDir, logger.child({ component: "server.api" }));
const wsManager = new WebSocketManager();

// Start file watcher
const sessionsDir = join(dataDir, "sessions");
const watcher = new SessionWatcher(sessionsDir, {
  onNewEntries(sessionId, entries) {
    wsManager.broadcastSessionUpdated(sessionId, entries);
  },
  async onNewSession(sessionId) {
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    try {
      const entries = await parseSessionFile(filePath);
      const meta = extractSessionMeta(filePath, entries);
      wsManager.broadcastSessionCreated(meta);
    } catch (error) {
      logger.debug("session_metadata_load_retry", {
        message: "Failed to load new session metadata; the file may still be writing.",
        sessionId,
        error,
        fields: { filePath },
      });
    }
  },
});
watcher.start();

// Resolve static files directory for production mode
const distDir = resolveStaticClientDir();
const hasDistDir = distDir !== null;

const server = Bun.serve<WsData>({
  port,
  async fetch(req, server) {
    // WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { subscriptions: new Set<string>() },
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    const apiResponse = await handleApi(req);
    if (apiResponse) return apiResponse;

    // Static file serving (production only)
    if (!dev && hasDistDir) {
      let filePath = join(distDir as string, url.pathname === "/" ? "index.html" : url.pathname);

      // SPA fallback: serve index.html for non-file routes
      if (!existsSync(filePath)) {
        filePath = join(distDir as string, "index.html");
      }

      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath));
      }
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsManager.handleOpen(ws);
    },
    message(ws, message) {
      wsManager.handleMessage(ws, message);
    },
    close(ws) {
      wsManager.handleClose(ws);
    },
  },
});

console.log(`
Diligent Debug Viewer
  Server running at http://localhost:${server.port}
  Data: ${dataDir}
  Mode: ${dev ? "development (use Vite dev server at :5173)" : hasDistDir ? "production" : "API only"}
  WebSocket: ws://localhost:${server.port}/ws
`);

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.stop();
  process.exit(0);
});

export { server };
