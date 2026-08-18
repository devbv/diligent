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

/**
 * A failure Studio described, with the description still attached.
 *
 * `message` is unchanged and is what every existing catch renders, so nothing that reads these
 * as plain Errors sees a difference. What is new is that `data` survives the throw: the
 * measurements below are rendered into the message for a reader, and a caller that wants to
 * decide something from them had no way to get at them except by parsing prose back out.
 */
export class StudioRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "StudioRpcError";
  }
}

let nextId = 1;

/**
 * Surface the work a failed batch had already finished.
 *
 * A batch that fails part-way still did everything before the failure, and Studio says so:
 * it puts the completed `waits`, `looks` and `pointerTargets` in `error.data`. This layer
 * used to render `error.message` and throw the rest away, so a run that timed out on wait 4
 * lost the measured timings of waits 1 to 3 — which were usually the numbers it was actually
 * after. One play test re-ran whole batches purely to recover figures the failed call had
 * already handed back and this function had dropped.
 *
 * Only the measurement arrays are rendered. The rest of `data` is diagnosis for the message
 * that is already printed above it.
 */
function renderMeasurements(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const sections: string[] = [];
  for (const key of ["waits", "looks", "pointerTargets"] as const) {
    const value = record[key];
    if (Array.isArray(value) && value.length > 0) {
      sections.push(`${key} that completed before the failure:\n${JSON.stringify(value, null, 2)}`);
    }
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

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
            errorMsg += renderMeasurements(response.error.data);
            errorMsg += `\n\nRequest was:\n${rawRequest}`;
            if (response.error.message?.toLowerCase().includes("guid")) {
              errorMsg += `\n\nTip: Use studiorpc_level_browse first to get valid GUIDs.`;
            }
            reject(new StudioRpcError(errorMsg, response.error.code, response.error.data));
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
