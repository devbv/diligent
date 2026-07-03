// @summary Shared app-server helpers for broadcasting server requests and handling responses

import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  type DiligentServerNotification,
  type DiligentServerRequestResponse,
  DiligentServerRequestResponseSchema,
} from "../protocol/index";
import type { RpcPeer } from "../rpc/channel";
import type { UserInputRequest, UserInputResponse } from "../tools/user-input-types";

export interface PendingServerRequest {
  method: string;
  resolve: (response: DiligentServerRequestResponse | null) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  sentTo: Set<string>;
  // Durable requests (no timeout, e.g. user input) survive a client disconnect so a
  // reconnecting/reloading client can still deliver the answer. They also carry the
  // original params + threadId so the server can re-deliver the prompt on (re)subscribe.
  durable: boolean;
  threadId?: string;
  params: unknown;
}

export interface ServerRequestPeer {
  id: string;
  peer: RpcPeer;
}

interface HandleServerResponseArgs {
  connectionId: string;
  message: { id: string | number; result?: unknown; error?: unknown };
  pendingServerRequests: Map<number, PendingServerRequest>;
  getConnectionById: (id: string) => ServerRequestPeer | undefined;
}

export async function handleServerResponseMessage(args: HandleServerResponseArgs): Promise<void> {
  const reqId = typeof args.message.id === "number" ? args.message.id : parseInt(String(args.message.id), 10);
  if (Number.isNaN(reqId)) return;

  const pending = args.pendingServerRequests.get(reqId);
  if (!pending) return;

  if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
  args.pendingServerRequests.delete(reqId);

  for (const otherId of pending.sentTo) {
    const other = args.getConnectionById(otherId);
    if (!other) continue;
    await other.peer.send({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      params: { requestId: reqId },
    } as DiligentServerNotification);
  }

  if ("error" in args.message && args.message.error !== undefined) {
    pending.resolve(null);
    return;
  }

  const parsed = DiligentServerRequestResponseSchema.safeParse({
    method: pending.method,
    result: args.message.result,
  });
  pending.resolve(parsed.success ? parsed.data : null);
}

interface BroadcastServerRequestArgs {
  method: string;
  params: unknown;
  connections: Map<string, ServerRequestPeer>;
  pendingServerRequests: Map<number, PendingServerRequest>;
  allocateServerRequestId: () => number;
  timeoutMs?: number | null;
  threadId?: string;
}

export async function broadcastServerRequest(
  args: BroadcastServerRequestArgs,
): Promise<DiligentServerRequestResponse | null> {
  if (args.connections.size === 0) return null;

  const id = args.allocateServerRequestId();
  const sentTo = new Set<string>();
  // Distinguish an explicit `null` (no timeout — wait indefinitely) from `undefined`
  // (use the default). Using `??` here would incorrectly coerce `null` to the default.
  const timeoutMs = args.timeoutMs === undefined ? 5 * 60 * 1000 : args.timeoutMs;
  const durable = timeoutMs === null;

  return new Promise<DiligentServerRequestResponse | null>((resolve) => {
    const timeoutId =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            args.pendingServerRequests.delete(id);
            for (const connectionId of sentTo) {
              const connection = args.connections.get(connectionId);
              if (!connection) continue;
              void connection.peer.send({
                method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
                params: { requestId: id },
              } as DiligentServerNotification);
            }
            resolve(null);
          }, timeoutMs);

    args.pendingServerRequests.set(id, {
      method: args.method,
      resolve,
      timeoutId,
      sentTo,
      durable,
      threadId: args.threadId,
      params: args.params,
    });

    for (const conn of args.connections.values()) {
      sentTo.add(conn.id);
      void conn.peer.send({ id, method: args.method, params: args.params });
    }
  });
}

interface RequestApprovalArgs {
  threadId: string;
  request: ApprovalRequest;
  connections: Map<string, ServerRequestPeer>;
  pendingServerRequests: Map<number, PendingServerRequest>;
  allocateServerRequestId: () => number;
}

export async function requestApprovalFromConnections(args: RequestApprovalArgs): Promise<ApprovalResponse> {
  if (args.connections.size === 0) return "once";

  const response = await broadcastServerRequest({
    method: DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST,
    params: { threadId: args.threadId, request: args.request },
    connections: args.connections,
    pendingServerRequests: args.pendingServerRequests,
    allocateServerRequestId: args.allocateServerRequestId,
    threadId: args.threadId,
  });
  if (!response) return "once";

  const parsed = DiligentServerRequestResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.method !== DILIGENT_SERVER_REQUEST_METHODS.APPROVAL_REQUEST) return "reject";
  return parsed.data.result.decision;
}

interface RequestUserInputArgs {
  threadId: string;
  request: UserInputRequest;
  connections: Map<string, ServerRequestPeer>;
  pendingServerRequests: Map<number, PendingServerRequest>;
  allocateServerRequestId: () => number;
}

export async function requestUserInputFromConnections(args: RequestUserInputArgs): Promise<UserInputResponse> {
  if (args.connections.size === 0) return { answers: {} };

  const response = await broadcastServerRequest({
    method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
    params: { threadId: args.threadId, request: args.request },
    connections: args.connections,
    pendingServerRequests: args.pendingServerRequests,
    allocateServerRequestId: args.allocateServerRequestId,
    timeoutMs: null,
    threadId: args.threadId,
  });
  if (!response) return { answers: {} };

  const parsed = DiligentServerRequestResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.method !== DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST) {
    return { answers: {} };
  }

  return parsed.data.result;
}
