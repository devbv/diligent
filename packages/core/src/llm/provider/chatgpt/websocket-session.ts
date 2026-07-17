// @summary Reusable, single-flight WebSocket transport for ChatGPT Responses Lite
import { ProviderError, ProviderErrorType } from "../../types";

export type ChatGPTWebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

export interface ChatGPTWebSocketSessionOptions {
  url: string;
  resolveHeaders: () => Promise<Record<string, string>>;
  webSocketFactory: ChatGPTWebSocketFactory;
  idleTimeoutMs: number;
  classifyError?: (payload: Record<string, unknown>) => Error;
  diagnostics?: {
    onOpen?: () => void;
    onSend?: (data: string, payload: Record<string, unknown>) => void;
    onReceive?: (payload: Record<string, unknown>, byteLength: number, pendingDecode: number) => void;
    onClose?: (code: number, reason: string, pendingDecode: number) => void;
    onError?: (opened: boolean, pendingDecode: number) => void;
    onTimeout?: (message: string, pendingDecode: number) => void;
  };
}

export interface ChatGPTWebSocketExchange {
  /** Resolves after the request has been written to the socket. */
  opened: Promise<void>;
  /** Response payloads for this exchange, ending at a terminal response event. */
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

async function decodeMessage(data: unknown): Promise<{ text: string; byteLength: number }> {
  if (typeof data === "string") {
    return { text: data, byteLength: new TextEncoder().encode(data).byteLength };
  }
  if (data instanceof ArrayBuffer) {
    return { text: new TextDecoder().decode(data), byteLength: data.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    return { text: new TextDecoder().decode(data), byteLength: data.byteLength };
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { text: await data.text(), byteLength: data.size };
  }
  const text = String(data);
  return { text, byteLength: new TextEncoder().encode(text).byteLength };
}

type ActiveExchange = {
  queue: AsyncEventQueue<Record<string, unknown>>;
  resolveOpened: () => void;
  rejectOpened: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type ConnectingSocket = {
  promise: Promise<WebSocket>;
  resolve: (socket: WebSocket) => void;
  reject: (error: Error) => void;
  socket?: WebSocket;
  cleanup?: () => void;
  settled: boolean;
};

/**
 * Maintains one physical WebSocket and serializes response.create exchanges over it.
 * A terminal successful response keeps the socket available for the next exchange;
 * every exceptional transport outcome discards it.
 */
export class ChatGPTWebSocketSession {
  private socket?: WebSocket;
  private connecting?: ConnectingSocket;
  private socketCleanup?: () => void;
  private active?: ActiveExchange;
  private disposed = false;
  private messageWork = Promise.resolve();
  private pendingMessageCount = 0;

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
      onAbort: () => this.invalidate(new ProviderError("Aborted", ProviderErrorType.Unknown, false)),
    };
    this.active = active;
    if (signal) signal.addEventListener("abort", active.onAbort, { once: true });
    if (signal?.aborted) active.onAbort();
    else {
      this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for connection");
      void this.send(request, active);
    }
    return { opened, events: queue };
  }

  /** Close an idle socket normally, or terminate the active exchange and socket. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active)
      this.invalidate(new ProviderError("ChatGPT WebSocket session disposed", ProviderErrorType.Network, false));
    else this.closeSocket(this.socket, false);
  }

  private async send(request: Record<string, unknown>, active: ActiveExchange): Promise<void> {
    try {
      const socket = await this.ensureSocket(active);
      if (this.active !== active) return;
      this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for send");
      const requestText = JSON.stringify(request);
      this.options.diagnostics?.onSend?.(requestText, request);
      try {
        socket.send(requestText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.invalidate(
          new ProviderError(`ChatGPT WebSocket send failed: ${message}`, ProviderErrorType.Network, true),
        );
        return;
      }
      active.resolveOpened();
      this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for response");
    } catch (error) {
      if (this.active === active) this.invalidate(this.asNetworkError(error));
    }
  }

  private ensureSocket(active: ActiveExchange): Promise<WebSocket> {
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting.promise;

    let resolve!: (socket: WebSocket) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<WebSocket>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const connecting: ConnectingSocket = {
      promise,
      resolve,
      reject,
      settled: false,
    };
    this.connecting = connecting;

    void (async () => {
      try {
        const headers = await this.options.resolveHeaders();
        if (this.connecting !== connecting || this.active !== active || this.disposed) return;
        const socket = this.options.webSocketFactory(this.options.url, headers);
        connecting.socket = socket;
        this.socket = socket;

        const onOpen = () => {
          if (this.connecting !== connecting) return;
          this.finishConnecting(connecting);
          this.attachSocketListeners(socket);
          this.options.diagnostics?.onOpen?.();
          connecting.resolve(socket);
        };
        const onError = () => {
          this.options.diagnostics?.onError?.(false, this.pendingMessageCount);
          this.failConnecting(
            connecting,
            new ProviderError("ChatGPT WebSocket connection failed", ProviderErrorType.Network, true),
          );
        };
        const onClose = (event: CloseEvent) => {
          this.options.diagnostics?.onClose?.(event.code, event.reason, this.pendingMessageCount);
          this.failConnecting(
            connecting,
            new ProviderError(
              `ChatGPT WebSocket connection closed before opening (${event.code}${
                event.reason ? `: ${event.reason}` : ""
              })`,
              ProviderErrorType.Network,
              true,
            ),
            false,
          );
        };
        connecting.cleanup = () => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("close", onClose, { once: true });
      } catch (error) {
        this.failConnecting(connecting, this.asNetworkError(error));
      }
    })();

    return promise;
  }

  private handleMessage(socket: WebSocket, event: MessageEvent): void {
    this.pendingMessageCount += 1;
    this.messageWork = this.messageWork
      .then(async () => {
        if (this.socket !== socket || !this.active) return;
        const decoded = await decodeMessage(event.data);
        const payload = JSON.parse(decoded.text) as Record<string, unknown>;
        this.options.diagnostics?.onReceive?.(payload, decoded.byteLength, this.pendingMessageCount);
        const active = this.active;
        if (payload.type === "error") {
          this.invalidate(
            this.options.classifyError?.(payload) ??
              new ProviderError("ChatGPT WebSocket request failed", ProviderErrorType.Unknown, false),
          );
          return;
        }
        if (payload.type === "response.failed") {
          active.queue.push(payload);
          this.clearActive(active);
          active.queue.end();
          this.closeSocket(this.socket, false);
          return;
        }
        active.queue.push(payload);
        if (payload.type === "response.completed" || payload.type === "response.incomplete") this.complete(active);
        else this.resetTimeout(active, "ChatGPT WebSocket idle timeout waiting for response");
      })
      .catch((error) => this.invalidate(this.asNetworkError(error, "ChatGPT WebSocket decode failed")))
      .finally(() => {
        this.pendingMessageCount = Math.max(0, this.pendingMessageCount - 1);
      });
  }

  private complete(active: ActiveExchange): void {
    if (this.active !== active) return;
    this.clearActive(active);
    active.queue.end();
  }

  private handleClose(socket: WebSocket, event: CloseEvent): void {
    this.options.diagnostics?.onClose?.(event.code, event.reason, this.pendingMessageCount);
    this.messageWork = this.messageWork
      .then(() => {
        if (this.socket !== socket) return;
        if (!this.active) {
          this.closeSocket(socket, false);
          return;
        }
        this.invalidate(
          new ProviderError(
            `ChatGPT WebSocket closed before a terminal response event (${event.code}${
              event.reason ? `: ${event.reason}` : ""
            })`,
            ProviderErrorType.Network,
            true,
          ),
          false,
        );
      })
      .catch((error) => this.invalidate(this.asNetworkError(error, "ChatGPT WebSocket close failed"), false));
  }

  private handleError(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.options.diagnostics?.onError?.(true, this.pendingMessageCount);
    this.invalidate(new ProviderError("ChatGPT WebSocket connection failed", ProviderErrorType.Network, true));
  }

  private resetTimeout(active: ActiveExchange, message: string): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      this.options.diagnostics?.onTimeout?.(message, this.pendingMessageCount);
      this.invalidate(new ProviderError(message, ProviderErrorType.Network, true));
    }, this.options.idleTimeoutMs);
  }

  private invalidate(error: Error, terminate = true): void {
    const connecting = this.connecting;
    if (connecting) {
      this.finishConnecting(connecting);
      connecting.reject(error);
    }
    const socket = this.socket ?? connecting?.socket;
    if (this.active) {
      const active = this.active;
      this.clearActive(active);
      active.rejectOpened(error);
      active.queue.fail(error);
    }
    this.closeSocket(socket, terminate);
  }

  private clearActive(active: ActiveExchange): void {
    if (this.active === active) this.active = undefined;
    if (active.timer) clearTimeout(active.timer);
    active.signal?.removeEventListener("abort", active.onAbort);
  }

  private asNetworkError(error: unknown, prefix = "ChatGPT WebSocket connection failed"): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(`${prefix}: ${message}`, ProviderErrorType.Network, true);
  }

  private attachSocketListeners(socket: WebSocket): void {
    const onMessage = (event: MessageEvent) => this.handleMessage(socket, event);
    const onError = () => this.handleError(socket);
    const onClose = (event: CloseEvent) => this.handleClose(socket, event);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    this.socketCleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
  }

  private failConnecting(connecting: ConnectingSocket, error: Error, terminate = true): void {
    if (this.connecting !== connecting) return;
    this.finishConnecting(connecting);
    connecting.reject(error);
    if (this.active) {
      const active = this.active;
      this.clearActive(active);
      active.rejectOpened(error);
      active.queue.fail(error);
    }
    this.closeSocket(connecting.socket, terminate);
  }

  private finishConnecting(connecting: ConnectingSocket): void {
    if (connecting.settled) return;
    connecting.settled = true;
    connecting.cleanup?.();
    if (this.connecting === connecting) this.connecting = undefined;
  }

  private closeSocket(socket: WebSocket | undefined, terminate: boolean): void {
    if (!socket) return;
    if (this.socket === socket) {
      this.socketCleanup?.();
      this.socketCleanup = undefined;
      this.socket = undefined;
    }
    if (socket.readyState === WebSocket.CLOSED) return;
    if (terminate) {
      const terminable = socket as WebSocket & { terminate?: () => void };
      if (typeof terminable.terminate === "function") terminable.terminate();
      else socket.close();
      return;
    }
    socket.close(1000);
  }
}

export function createChatGPTWebSocketSession(options: ChatGPTWebSocketSessionOptions): ChatGPTWebSocketSession {
  return new ChatGPTWebSocketSession(options);
}
