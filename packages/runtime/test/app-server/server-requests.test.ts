// @summary Tests for app-server server-request broadcast timeout behavior

import { describe, expect, it } from "bun:test";
import {
  DILIGENT_SERVER_NOTIFICATION_METHODS,
  DILIGENT_SERVER_REQUEST_METHODS,
  type JSONRPCMessage,
} from "@diligent/protocol";
import { broadcastServerRequest, handleServerResponseMessage } from "@diligent/runtime/app-server/server-requests";

describe("broadcastServerRequest", () => {
  it("emits server_request_resolved to recipients when request times out", async () => {
    const received: JSONRPCMessage[] = [];
    const connections = new Map([
      [
        "conn-1",
        {
          id: "conn-1",
          peer: {
            async send(message: JSONRPCMessage) {
              received.push(message);
            },
            onMessage() {},
          },
        },
      ],
    ]);

    const pending = new Map();
    let nextId = 1;

    const response = await broadcastServerRequest({
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      params: { threadId: "thread-1", request: { questions: [] } },
      connections,
      pendingServerRequests: pending,
      allocateServerRequestId: () => nextId++,
      timeoutMs: 20,
    });

    expect(response).toBeNull();

    const request = received.find((m) => "id" in m && "method" in m);
    expect(request).toBeDefined();

    const resolvedNotification = received.find(
      (m) => "method" in m && !("id" in m) && m.method === DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
    );
    expect(resolvedNotification).toBeDefined();
    expect((resolvedNotification as { params?: { requestId?: number } }).params?.requestId).toBe(1);
    expect(pending.size).toBe(0);
  });

  it("can wait without a timeout and resolves the responding client", async () => {
    const received: JSONRPCMessage[] = [];
    const connections = new Map([
      [
        "conn-1",
        {
          id: "conn-1",
          peer: {
            async send(message: JSONRPCMessage) {
              received.push(message);
            },
            onMessage() {},
          },
        },
      ],
    ]);
    const pending = new Map();

    const responsePromise = broadcastServerRequest({
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      params: { threadId: "thread-1", request: { questions: [] } },
      connections,
      pendingServerRequests: pending,
      allocateServerRequestId: () => 7,
      timeoutMs: null,
    });

    expect(pending.size).toBe(1);

    await handleServerResponseMessage({
      connectionId: "conn-1",
      message: { id: 7, result: { answers: { q1: "yes" } } },
      pendingServerRequests: pending,
      getConnectionById: (id) => connections.get(id),
    });

    await expect(responsePromise).resolves.toEqual({
      method: DILIGENT_SERVER_REQUEST_METHODS.USER_INPUT_REQUEST,
      result: { answers: { q1: "yes" } },
    });
    expect(received).toContainEqual({
      method: DILIGENT_SERVER_NOTIFICATION_METHODS.SERVER_REQUEST_RESOLVED,
      params: { requestId: 7 },
    });
    expect(pending.size).toBe(0);
  });
});
