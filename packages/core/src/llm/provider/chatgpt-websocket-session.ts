// @summary Reusable, single-flight WebSocket transport for ChatGPT Responses Lite
import { ProviderError } from "../types";

/**
 * Thrown by a ChatGPTWebSocketFactory when the HTTP upgrade handshake itself
 * fails before the WebSocket is established. The factory receives the HTTP
 * status code and response body so that error classification can be precise
 * (401/403 = auth, 429 usage-limit = non-retryable, 5xx = retryable).
 */
export class ChatGPTWebSocketUpgradeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly upgradeHeaders: Record<string, string> = {},
  ) {
    super(`ChatGPT WebSocket upgrade failed with HTTP ${status}`);
    this.name = "ChatGPTWebSocketUpgradeError";
  }
}

/**
 * Maps an HTTP upgrade failure to a classified ProviderError using the same
 * status-code rules as the ChatGPT HTTP/SSE path:
 * - 401/403 → auth (non-retryable)
 * - 429 with usage_limit_reached body → "unknown" (non-retryable)
 * - 429 without usage_limit → rate_limit (non-retryable)
 * - 5xx → server_error (retryable)
 */
export function classifyWebSocketUpgradeError(status: number, body: string): ProviderError {
  const isUsageLimit = body.includes("usage_limit_reached");
  const is429 = status === 429;
  const message =
    is429 && isUsageLimit
      ? "AI usage limit reached. Please try again later or upgrade your plan."
      : `ChatGPT WebSocket upgrade failed (${status}): ${body || "no body"}`;
  return new ProviderError(
    message,
    is429 && isUsageLimit
      ? "unknown"
      : is429
        ? "rate_limit"
        : status >= 500
          ? "server_error"
          : status === 401 || status === 403
            ? "auth"
            : "unknown",
    !is429 && status >= 500,
    undefined,
    status,
  );
}

/**
 * Factory that creates (or async-resolves) a WebSocket for the given URL and
 * headers. Implementations may throw (or reject with) a
 * ChatGPTWebSocketUpgradeError to surface HTTP-level upgrade failures with
 * precise status and body information.
 */
export type ChatGPTWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket | Promise<WebSocket>;

export interface ChatGPTWebSocketSessionOptions {
  url: string;
  resolveHeaders: () => Promise<Record<string, string>>;
  webSocketFactory: ChatGPTWebSocketFactory;
  idleTimeoutMs: number;
}

export interface ChatGPTWebSocketExchange {
  /** Resolves after the request has been written to the socket. */
  opened: Promise<void>;
  /** Response payloads for this exchange, ending at response.completed. */
  events: AsyncIterable<Record<string, unknown>>;
}

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private done = false;
  private failure?: Error;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true });
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.done) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

async function messageToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

type ActiveExchange = {
  queue: AsyncEventQueue<Record<string, unknown>>;
  resolveOpened: () => void;
  rejectOpened: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Maintains one physical WebSocket and serializes response.create exchanges over it.
 * A terminal successful response keeps the socket available for the next exchange;
 * every exceptional transport outcome discards it.
 */
export class ChatGPTWebSocketSession {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private active?: ActiveExchange;
  private disposed = false;
  private messageWork = Promise.resolve();

  constructor(private readonly options: ChatGPTWebSocketSessionOptions) {}

  streamRequest(request: Record<string, unknown>, signal?: AbortSignal): ChatGPTWebSocketExchange {
    if (this.disposed) throw new Error("ChatGPT WebSocket session has been disposed");
    if (this.active) throw new Error("ChatGPT WebSocket session already has an active exchange");

    const queue = new AsyncEventQueue<Record<string, unknown>>();
    let resolveOpened!: () => void;
    let rejectOpened!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    const active: ActiveExchange = {
      queue,
      resolveOpened,
      rejectOpened,
      signal,
      onAbort: () => this.invalidate(new ProviderError("Aborted", "unknown", false)),
    };
    this.active = active;
    if (signal) signal.addEventListener("abort", active.onAbort, { once: true });
    if (signal?.aborted) active.onAbort();
    else void this.send(request, active);
    return { opened, events: queue };
  }

  /** Close an idle socket normally, or terminate the active exchange and socket. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.invalidate(new ProviderError("ChatGPT WebSocket session disposed", "network", false));
    else if (this.socket && this.socket.readyState !== 3) this.socket.close(1000);
    this.socket = undefined;
  }

  private async send(request: Record<string, unknown>, active: ActiveExchange): Promise<void> {
    try {
      const socket = await this.ensureSocket();
      if (this.active !== active) return;
      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.invalidate(new ProviderError(`ChatGPT WebSocket send failed: ${message}`, "network", true));
        return;
      }
      active.resolveOpened();
      this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for response");
    } catch (error) {
      if (this.active === active) this.invalidate(this.asNetworkError(error));
    }
  }

  private ensureSocket(): Promise<WebSocket> {
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const headers = await this.options.resolveHeaders();
      let socket: WebSocket;
      try {
        const factoryResult = this.options.webSocketFactory(this.options.url, headers);
        socket = factoryResult instanceof Promise ? await factoryResult : factoryResult;
      } catch (error) {
        this.connecting = undefined;
        throw error instanceof ChatGPTWebSocketUpgradeError
          ? classifyWebSocketUpgradeError(error.status, error.body)
          : new ProviderError("ChatGPT WebSocket connection failed", "network", true);
      }
      this.socket = socket;
      socket.addEventListener("message", (event) => this.handleMessage(socket, event));
      socket.addEventListener("error", () =>
        this.handleTransportFailure(socket, "ChatGPT WebSocket connection failed"),
      );
      socket.addEventListener("close", (event) =>
        this.handleTransportFailure(
          socket,
          `ChatGPT WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        ),
      );
      return new Promise<WebSocket>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          this.connecting = undefined;
          resolve(socket);
        };
        const onFailure = () => {
          cleanup();
          this.connecting = undefined;
          const error = new ProviderError("ChatGPT WebSocket connection failed", "network", true);
          if (this.socket === socket) this.socket = undefined;
          reject(error);
        };
        const cleanup = () => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onFailure);
          socket.removeEventListener("close", onFailure);
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onFailure, { once: true });
        socket.addEventListener("close", onFailure, { once: true });
      });
    })();
    return this.connecting;
  }

  private handleMessage(socket: WebSocket, event: MessageEvent): void {
    this.messageWork = this.messageWork
      .then(async () => {
        if (this.socket !== socket || !this.active) return;
        const payload = JSON.parse(await messageToString(event.data)) as Record<string, unknown>;
        const active = this.active;
        if (payload.type === "error") {
          this.invalidate(new ProviderError("ChatGPT WebSocket request failed", "unknown", false));
          return;
        }
        if (payload.type === "response.failed") {
          active.queue.push(payload);
          this.clearActive(active);
          active.queue.end();
          const failedSocket = this.socket;
          this.socket = undefined;
          if (failedSocket && failedSocket.readyState !== WebSocket.CLOSED) failedSocket.close();
          return;
        }
        active.queue.push(payload);
        if (payload.type === "response.completed") this.complete(active);
        else this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for response");
      })
      .catch((error) => this.invalidate(this.asNetworkError(error, "ChatGPT WebSocket decode failed")));
  }

  private complete(active: ActiveExchange): void {
    if (this.active !== active) return;
    this.clearActive(active);
    active.queue.end();
  }

  private handleTransportFailure(socket: WebSocket, message: string): void {
    if (this.socket !== socket) return;
    this.invalidate(new ProviderError(message, "network", true), false);
  }

  private resetTimeout(active: ActiveExchange, message: string): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(
      () => this.invalidate(new ProviderError(message, "network", true)),
      this.options.idleTimeoutMs,
    );
  }

  private invalidate(error: Error, terminate = true): void {
    const socket = this.socket;
    this.socket = undefined;
    if (this.active) {
      const active = this.active;
      this.clearActive(active);
      active.rejectOpened(error);
      active.queue.fail(error);
    }
    if (terminate && socket && socket.readyState !== 3) {
      const terminable = socket as WebSocket & { terminate?: () => void };
      if (typeof terminable.terminate === "function") terminable.terminate();
      else socket.close();
    }
  }

  private clearActive(active: ActiveExchange): void {
    if (this.active === active) this.active = undefined;
    if (active.timer) clearTimeout(active.timer);
    active.signal?.removeEventListener("abort", active.onAbort);
  }

  private asNetworkError(error: unknown, prefix = "ChatGPT WebSocket connection failed"): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(`${prefix}: ${message}`, "network", true);
  }
}

export function createChatGPTWebSocketSession(options: ChatGPTWebSocketSessionOptions): ChatGPTWebSocketSession {
  return new ChatGPTWebSocketSession(options);
}
