// @summary Deleting the connection's current thread must clear currentThreadId so
// later thread-scoped requests (e.g. TOOLS_LIST) don't resolve a deleted thread.
import { describe, expect, it } from "bun:test";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import {
  applySessionDefaults,
  type ClientRequestDispatchContext,
  type ConnectedPeer,
  dispatchClientRequest,
} from "@diligent/runtime/app-server/request-dispatcher";

function makeConn(currentThreadId: string | null): ConnectedPeer {
  return {
    id: "conn-1",
    peer: {} as ConnectedPeer["peer"],
    subscriptions: new Set(),
    currentThreadId,
    cwd: "/tmp/project",
    mode: "default",
    effort: "medium",
  };
}

function makeCtx(conn: ConnectedPeer): ClientRequestDispatchContext {
  const threads = new Map<string, { manager: { dispose: () => void } }>([["A", { manager: { dispose: () => {} } }]]);
  let activeThreadId: string | null = "A";
  return {
    getConnection: () => conn,
    setConnectionCurrentThreadId: (_connectionId: string, threadId: string | null) => {
      conn.currentThreadId = threadId;
    },
    threadHandlersCtx: {
      threads,
      knownCwds: new Set<string>(),
      activeThreadId,
      resolvePaths: async () => ({ sessions: "/tmp/project/.diligent/sessions" }),
      setActiveThreadId: (id: string | null) => {
        activeThreadId = id;
      },
    },
  } as unknown as ClientRequestDispatchContext;
}

describe("THREAD_DELETE clears connection currentThreadId", () => {
  it("clears currentThreadId when the deleted thread is the current one", async () => {
    const conn = makeConn("A");
    const ctx = makeCtx(conn);

    await dispatchClientRequest(ctx, "conn-1", {
      method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE,
      params: { threadId: "A" },
    });

    expect(conn.currentThreadId).toBeNull();
  });

  it("after deletion, TOOLS_LIST no longer inherits the deleted thread id", async () => {
    const conn = makeConn("A");
    const ctx = makeCtx(conn);

    await dispatchClientRequest(ctx, "conn-1", {
      method: DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE,
      params: { threadId: "A" },
    });

    // The client sends TOOLS_LIST with no threadId after entering draft mode.
    const injected = applySessionDefaults("conn-1", DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST, {}, () => conn);
    expect(injected.threadId).toBeUndefined();
  });
});
