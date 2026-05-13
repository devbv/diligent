// @summary Browser WebSocket JSON-RPC client with reconnect support and server-request handling
import type {
  DiligentClientRequest,
  DiligentClientResponse,
  DiligentServerNotification,
  DiligentServerRequest,
  DiligentServerRequestResponse,
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
} from "@diligent/protocol";
import {
  DILIGENT_CLIENT_REQUEST_METHODS,
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  JSONRPCMessageSchema,
} from "@diligent/protocol";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 5000, 5000] as const;

type RequestMethod = DiligentClientRequest["method"];
type RequestParams<M extends RequestMethod> = Extract<DiligentClientRequest, { method: M }>["params"];
type RequestResult<M extends RequestMethod> = Extract<DiligentClientResponse, { method: M }>["result"];

const WEB_REQUEST_METHOD_KEYS = [
  "CONFIG_SET",
  "AUTH_LIST",
  "AUTH_SET",
  "AUTH_REMOVE",
  "AUTH_OAUTH_START",
  "AUTH_OAUTH_CANCEL",
  "THREAD_SUBSCRIBE",
  "THREAD_UNSUBSCRIBE",
  "IMAGE_UPLOAD",
] as const satisfies readonly (keyof typeof DILIGENT_CLIENT_REQUEST_METHODS)[];

type WebRequestMethodKey = (typeof WEB_REQUEST_METHOD_KEYS)[number];
type WebMethod = (typeof DILIGENT_CLIENT_REQUEST_METHODS)[WebRequestMethodKey];
type WebParams<M extends WebMethod> = Extract<DiligentClientRequest, { method: M }>["params"];
type WebResult<M extends WebMethod> = Extract<DiligentClientResponse, { method: M }>["result"];

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface PendingServerRequest {
  method: DiligentServerRequest["method"];
}

export class WebRpcClient {
  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reconnectDelays = [...RECONNECT_DELAYS_MS];
  private reconnectAttempts = 0;
  private stopped = false;

  private readonly activeSubscriptions = new Map<string, string>(); // subscriptionId → threadId
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>();

  private connectionListener: ((state: ConnectionState) => void) | null = null;
  private notificationListener: ((notification: DiligentServerNotification) => void) | null = null;
  private serverRequestListener: ((id: number, request: DiligentServerRequest) => void) | null = null;

  constructor(private readonly url: string) {}

  onConnectionChange(listener: ((state: ConnectionState) => void) | null): void {
    this.connectionListener = listener;
  }

  onNotification(listener: ((notification: DiligentServerNotification) => void) | null): void {
    this.notificationListener = listener;
  }

  onServerRequest(listener: ((id: number, request: DiligentServerRequest) => void) | null): void {
    this.serverRequestListener = listener;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.emitConnection("connecting");
    try {
      await this.openSocket();
    } catch {
      if (this.stopped) {
        this.emitConnection("disconnected");
        return;
      }
      await this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.activeSubscriptions.clear();
    this.pendingServerRequests.clear();
    this.rejectPending("disconnected");
    this.emitConnection("disconnected");
  }

  async initialize(
    params: RequestParams<"initialize">,
    timeoutMs: number | null = 30_000,
  ): Promise<RequestResult<"initialize">> {
    const result = await this.requestRaw("initialize", params, timeoutMs);
    this.resubscribeAll();
    return result as RequestResult<"initialize">;
  }

  async request<M extends Exclude<RequestMethod, "initialize">>(
    method: M,
    params: RequestParams<M>,
    timeoutMs: number | null = 30_000,
  ): Promise<RequestResult<M>> {
    const result = await this.requestRaw(method, params, timeoutMs);
    return result as RequestResult<M>;
  }

  async webRequest<M extends WebMethod>(
    method: M,
    params: WebParams<M>,
    timeoutMs: number | null = 30_000,
  ): Promise<WebResult<M>> {
    return this.requestRaw(method, params, timeoutMs) as Promise<WebResult<M>>;
  }

  async requestRaw(method: string, params: unknown, timeoutMs: number | null = 30_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const id = this.nextRequestId++;
    const payload: JSONRPCRequest = { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeoutId =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`RPC timeout for ${method}`));
            }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
      ws.send(JSON.stringify(payload));
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload: JSONRPCNotification = params === undefined ? { method } : { method, params };
    this.ws.send(JSON.stringify(payload));
  }

  async subscribe(threadId: string): Promise<{ subscriptionId: string }> {
    const result = (await this.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE, { threadId })) as {
      subscriptionId: string;
    };
    this.activeSubscriptions.set(result.subscriptionId, threadId);
    return result;
  }

  async unsubscribe(subscriptionId: string): Promise<{ ok: boolean }> {
    const result = (await this.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_UNSUBSCRIBE, { subscriptionId })) as {
      ok: boolean;
    };
    if (result.ok) {
      this.activeSubscriptions.delete(subscriptionId);
    }
    return result;
  }

  respondServerRequest(id: number, response: DiligentServerRequestResponse): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.pendingServerRequests.delete(id);
    const payload: JSONRPCResponse = { id, result: response.result };
    this.ws.send(JSON.stringify(payload));
  }

  private async openSocket(): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        this.reconnectAttempts = 0;
        this.emitConnection("connected");
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        this.ws = null;
        ws.onclose = null;
        reject(new Error("WebSocket open failed"));
      };

      ws.onclose = () => {
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket open failed"));
          return;
        }
        if (this.stopped) {
          this.emitConnection("disconnected");
          return;
        }
        void this.scheduleReconnect();
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    }).catch((error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      throw error;
    });

    if (this.ws !== ws) {
      if (this.stopped) {
        this.emitConnection("disconnected");
        return;
      }
      void this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.reconnectDelays.length) {
      this.emitConnection("disconnected");
      this.rejectPending("reconnect attempts exhausted");
      return;
    }

    const delay = this.reconnectDelays[this.reconnectAttempts++];
    this.emitConnection("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.stopped) {
      this.emitConnection("disconnected");
      return;
    }

    try {
      await this.openSocket();
    } catch {
      await this.scheduleReconnect();
    }
  }

  private handleMessage(raw: unknown): void {
    let message: JSONRPCMessage;
    try {
      message = JSONRPCMessageSchema.parse(JSON.parse(String(raw)));
    } catch {
      return;
    }

    if (this.isResponse(message)) {
      this.handleRpcResponse(message);
      return;
    }

    if (this.isRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    this.handleNotification(message);
  }

  private handleServerRequest(message: JSONRPCRequest): void {
    const requestId = Number(message.id);
    if (!Number.isInteger(requestId) || requestId < 0) {
      return;
    }

    const request = {
      method: message.method,
      params: message.params,
    } as DiligentServerRequest;

    this.pendingServerRequests.set(requestId, { method: request.method });
    this.serverRequestListener?.(requestId, request);
  }

  private handleNotification(notification: JSONRPCNotification): void {
    if (notification.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED) {
      const requestId = (notification.params as { requestId?: number } | undefined)?.requestId;
      if (typeof requestId === "number") {
        this.pendingServerRequests.delete(requestId);
        this.notificationListener?.({
          method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
          params: { requestId },
        } as DiligentServerNotification);
      }
      return;
    }

    const parsed = {
      method: notification.method,
      params: notification.params,
    } as DiligentServerNotification;

    this.notificationListener?.(parsed);
  }

  private handleRpcResponse(response: JSONRPCResponse): void {
    const id = Number(response.id);
    const pending = this.pending.get(id);
    if (pending) {
      if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
      this.pending.delete(id);

      if ("error" in response) {
        pending.reject(new Error(response.error.message));
        return;
      }

      pending.resolve(response.result);
      return;
    }

    const serverRequest = this.pendingServerRequests.get(id);
    if (!serverRequest) {
      return;
    }

    this.pendingServerRequests.delete(id);
    if ("error" in response) {
      return;
    }

    this.notificationListener?.({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      params: { requestId: id },
    } as DiligentServerNotification);
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private resubscribeAll(): void {
    const threadIds = new Set(this.activeSubscriptions.values());
    this.activeSubscriptions.clear();

    for (const threadId of threadIds) {
      void this.subscribe(threadId).catch(() => {});
    }
  }

  private isResponse(message: JSONRPCMessage): message is JSONRPCResponse {
    return "id" in message && ("result" in message || "error" in message);
  }

  private isRequest(message: JSONRPCMessage): message is JSONRPCRequest {
    return "id" in message && "method" in message;
  }

  private emitConnection(state: ConnectionState): void {
    this.connectionListener?.(state);
  }
}

export function getReconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1)];
}

export function getReconnectAttemptLimit(): number {
  return RECONNECT_DELAYS_MS.length;
}
