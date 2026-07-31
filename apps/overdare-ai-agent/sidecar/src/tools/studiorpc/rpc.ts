import net from "node:net";
import readline from "node:readline";
import { createLogger } from "@diligent/logging";
import { resolveStudioHost, resolveStudioPort } from "./config";

const DEFAULT_TIMEOUT_MS = 10_000;
const logger = createLogger({ scope: "sidecar/studiorpc", context: { component: "rpc" } });

export interface StudioRpcCallOptions {
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;

/**
 * Send a JSON-RPC 2.0 request over a TCP socket to OVERDARE Studio.
 *
 * Configuration (in priority order):
 *   1. STUDIO_HOST / STUDIO_PORT environment variables
 *   2. ~/.<storage-namespace>/overdare.jsonc config file
 *   3. Hard-coded defaults: localhost:13377
 */
/**
 * Apply pending level changes.
 * Returns the result of `level.apply`.
 */
export async function applyLevelChanges(): Promise<unknown> {
  return call("level.apply", {});
}

export async function call(
  method: string,
  params?: Record<string, unknown>,
  options: StudioRpcCallOptions = {},
): Promise<unknown> {
  const host = resolveStudioHost();
  const port = resolveStudioPort();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const id = nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && Object.keys(params).length > 0 && { params }),
    };

    // Guard against double-settlement: on Windows, Bun's happy-eyeballs
    // dual-stack (::1 then 127.0.0.1) can emit two consecutive error events
    // on the same socket.  Without this flag the second error escapes all
    // handlers and crashes the process.
    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      fn();
    }

    // On Windows, Bun resolves "localhost" via happy-eyeballs (tries ::1 and
    // 127.0.0.1 simultaneously).  When both fail the error events bypass
    // user-space handlers and crash the process.  Force IPv4 to use a single
    // connection attempt so our error handler is reliably invoked.
    const connectHost = host === "localhost" ? "127.0.0.1" : host;
    const rawRequest = JSON.stringify(request);
    logger.debug("request.sent", {
      message: `[RPC →] ${rawRequest}`,
      fields: { id, method },
    });
    const socket = net.createConnection({ host: connectHost, port }, () => {
      socket.write(`${rawRequest}\n`);
    });

    const rl = readline.createInterface({ input: socket });

    const timer = setTimeout(() => {
      settle(() => {
        cleanup();
        reject(
          new Error(
            `Studio RPC timed out (${method}).\n` +
              `Make sure OVERDARE Studio is running. If the problem persists, restart the agent.`,
          ),
        );
      });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      rl.close();
      socket.destroy();
    }

    rl.once("line", (line) => {
      settle(() => {
        cleanup();
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          logger.debug("response.received", {
            message: `[RPC ←] ${line}`,
            fields: { id, method },
          });
          if (response.error) {
            let errorMsg = `Studio RPC error [${response.error.code}]: ${response.error.message}`;
            errorMsg += `\n\nRequest was:\n${rawRequest}`;
            if (response.error.message?.toLowerCase().includes("guid")) {
              errorMsg += `\n\nTip: Use studiorpc_level_browse first to get valid GUIDs.`;
            }
            reject(new Error(errorMsg));
          } else {
            resolve(response.result);
          }
        } catch {
          reject(new Error(`Failed to parse Studio RPC response.\nReceived: ${line.substring(0, 200)}`));
        }
      });
    });

    socket.on("error", () => {
      settle(() => {
        cleanup();
        reject(
          new Error(
            `Could not connect to Studio RPC server.\n` +
              `Make sure OVERDARE Studio is running. If the problem persists, restart the agent.`,
          ),
        );
      });
    });
  });
}
