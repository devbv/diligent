import net from "node:net";
import readline from "node:readline";
import { createLogger } from "@diligent/logging";
import { resolveStudioHost, resolveStudioPort } from "./config";

const DEFAULT_TIMEOUT_MS = 10_000;
const logger = createLogger({ scope: "sidecar/studiorpc", context: { component: "rpc" } });

export interface StudioRpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
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
  options.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const id = nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && Object.keys(params).length > 0 && { params }),
    };
    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      fn();
    }
    const connectHost = host === "localhost" ? "127.0.0.1" : host;
    const rawRequest = JSON.stringify(request);
    logger.debug("request.sent", {
      message: `[RPC →] ${method} (${rawRequest.length} bytes)`,
      fields: { id, method, bytes: rawRequest.length },
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

    const onAbort = () => {
      settle(() => {
        cleanup();
        reject(options.signal?.reason ?? new DOMException("Studio RPC call aborted", "AbortError"));
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rl.close();
      socket.destroy();
    }

    rl.once("line", (line) => {
      settle(() => {
        cleanup();
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          logger.debug("response.received", {
            message: `[RPC ←] ${method} (${line.length} bytes)`,
            fields: { id, method, bytes: line.length },
          });
          if (response.error) {
            let errorMsg = `Studio RPC error [${response.error.code}]: ${response.error.message}`;
            errorMsg += renderMeasurements(response.error.data);
            errorMsg += `\n\nRequest method: ${method} (id ${id})`;
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
