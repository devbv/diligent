// @summary Factory for thread lifecycle operations (start, resume, list, read, delete)
import type { Mode as ProtocolMode, SessionSummary, ThreadReadResponse } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { AppServerRpcClient } from "./rpc-client";

export interface ThreadManagerDeps {
  getRpcClient: () => AppServerRpcClient | null;
  getCurrentMode: () => ProtocolMode;
  setCurrentThreadId: (id: string | null) => void;
  updateStatusBar: (updates: { sessionId: string }) => void;
}

export interface ThreadManager {
  startNewThread: () => Promise<string>;
  resumeThread: (threadId?: string) => Promise<string | null>;
  listThreads: () => Promise<SessionSummary[]>;
  readThread: () => Promise<ThreadReadResponse | null>;
  readThreadById: (threadId: string) => Promise<ThreadReadResponse | null>;
  deleteThread: (threadId: string) => Promise<boolean>;
}

export function createThreadManager(deps: ThreadManagerDeps): ThreadManager {
  let currentThreadId: string | null = null;

  // Keep a local shadow of currentThreadId so readThread/deleteThread can reference it.
  // The authoritative value still lives in App via setCurrentThreadId.
  const setThread = (id: string | null) => {
    currentThreadId = id;
    deps.setCurrentThreadId(id);
  };

  const manager: ThreadManager = {
    async startNewThread(): Promise<string> {
      const rpc = deps.getRpcClient();
      if (!rpc) {
        throw new Error("App server is not initialized.");
      }
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_START, {
        cwd: process.cwd(),
        mode: deps.getCurrentMode(),
      });
      setThread(response.threadId);
      deps.updateStatusBar({ sessionId: response.threadId });
      await rpc
        .request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE, { threadId: response.threadId })
        .catch(() => {});
      return response.threadId;
    },

    async resumeThread(threadId?: string): Promise<string | null> {
      const rpc = deps.getRpcClient();
      if (!rpc) {
        throw new Error("App server is not initialized.");
      }
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_RESUME, {
        threadId,
        mostRecent: threadId ? undefined : true,
      });
      if (!response.found || !response.threadId) {
        return null;
      }
      setThread(response.threadId);
      deps.updateStatusBar({ sessionId: response.threadId });
      await rpc
        .request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_SUBSCRIBE, { threadId: response.threadId })
        .catch(() => {});
      return response.threadId;
    },

    async listThreads(): Promise<SessionSummary[]> {
      const rpc = deps.getRpcClient();
      if (!rpc) {
        return [];
      }
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_LIST, {});
      return response.data;
    },

    async readThread(): Promise<ThreadReadResponse | null> {
      const rpc = deps.getRpcClient();
      if (!rpc || !currentThreadId) {
        return null;
      }
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId: currentThreadId });
    },

    async readThreadById(threadId: string): Promise<ThreadReadResponse | null> {
      const rpc = deps.getRpcClient();
      if (!rpc) {
        return null;
      }
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId });
    },

    async deleteThread(threadId: string): Promise<boolean> {
      const rpc = deps.getRpcClient();
      if (!rpc) return false;
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_DELETE, { threadId });
      if (response.deleted && currentThreadId === threadId) {
        const resumed = await manager.resumeThread();
        if (!resumed) {
          await manager.startNewThread();
        }
      }
      return response.deleted;
    },
  };

  return manager;
}
