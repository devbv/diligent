import { existsSync } from "fs";
import { join, resolve } from "path";
import { createApiHandler } from "./api.js";
import { findDiligentDir } from "./find-diligent-dir.js";
import { extractSessionMeta, parseSessionFile } from "./parser.js";
import { SessionWatcher } from "./watcher.js";
import { WebSocketManager, type WsData } from "./websocket.js";

// Parse CLI args
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="))?.split("=")[1];
const port = portArg
  ? Number.parseInt(portArg, 10)
  : args.includes("--port")
    ? Number.parseInt(args[args.indexOf("--port") + 1], 10)
    : 7432;
const sample = args.includes("--sample");
const dev = args.includes("--dev");

// Find data directory
const dataDir = findDiligentDir({ sample });
if (!dataDir) {
  console.error("Could not find .diligent/ directory. Run with --sample to use sample data.");
  process.exit(1);
}

console.log(`Data directory: ${dataDir}`);

const handleApi = createApiHandler(dataDir);
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
    } catch {
      // file may not be fully written yet
    }
  },
});
watcher.start();

// Resolve static files directory for production mode
const distDir = resolve(import.meta.dir, "../../dist/client");
const hasDistDir = existsSync(distDir);

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
      let filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);

      // SPA fallback: serve index.html for non-file routes
      if (!existsSync(filePath)) {
        filePath = join(distDir, "index.html");
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
${sample ? "  Using sample data\n" : ""}`);

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.stop();
  process.exit(0);
});

export { server };
