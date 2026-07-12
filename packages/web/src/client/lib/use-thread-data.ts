// @summary RPC data operation hooks: tools, knowledge, child-thread fetch, and derived display values
import type {
  KnowledgeEntry,
  KnowledgeUpdateParams,
  McpListResponse,
  McpLoginStartResponse,
  McpLogoutResponse,
  SkillsListResponse,
  SkillsSetParams,
  SkillsSetResponse,
  SubagentsListResponse,
  SubagentsSetParams,
  SubagentsSetResponse,
  ThreadReadResponse,
  ToolsListResponse,
  ToolsSetParams,
  ToolsSetResponse,
} from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { RefObject } from "react";
import { useCallback, useMemo } from "react";
import type { ThreadState } from "./thread-store";
import type { useRpcClient } from "./use-rpc";

type RpcClientResult = ReturnType<typeof useRpcClient>;

export function useThreadData({
  rpcRef,
  state,
  childThreadCacheRef,
}: {
  rpcRef: RpcClientResult["rpcRef"];
  state: ThreadState;
  childThreadCacheRef: RefObject<Map<string, ThreadReadResponse>>;
}) {
  const listTools = useCallback(async (): Promise<ToolsListResponse> => {
    const rpc = rpcRef.current;
    if (!rpc) throw new Error("WebSocket is not connected");
    return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_LIST, {
      threadId: state.activeThreadId ?? undefined,
    });
  }, [rpcRef, state.activeThreadId]);

  const saveTools = useCallback(
    async (params: ToolsSetParams): Promise<ToolsSetResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.TOOLS_SET, params);
    },
    [rpcRef],
  );

  const listSkills = useCallback(
    async (threadId?: string): Promise<SkillsListResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_LIST, {
        threadId: threadId ?? state.activeThreadId ?? undefined,
      });
    },
    [rpcRef, state.activeThreadId],
  );

  const saveSkills = useCallback(
    async (params: SkillsSetParams): Promise<SkillsSetResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SKILLS_SET, {
        ...params,
        threadId: params.threadId ?? state.activeThreadId ?? undefined,
      });
    },
    [rpcRef, state.activeThreadId],
  );

  const listSubagents = useCallback(
    async (threadId?: string): Promise<SubagentsListResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_LIST, {
        threadId: threadId ?? state.activeThreadId ?? undefined,
      });
    },
    [rpcRef, state.activeThreadId],
  );

  const saveSubagents = useCallback(
    async (params: SubagentsSetParams): Promise<SubagentsSetResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.SUBAGENTS_SET, {
        ...params,
        threadId: params.threadId ?? state.activeThreadId ?? undefined,
      });
    },
    [rpcRef, state.activeThreadId],
  );

  const listKnowledge = useCallback(
    async (threadId?: string): Promise<{ data: KnowledgeEntry[] }> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_LIST, { threadId, limit: 500 });
    },
    [rpcRef],
  );

  const updateKnowledge = useCallback(
    async (params: KnowledgeUpdateParams): Promise<{ entry?: KnowledgeEntry; deleted?: boolean }> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.KNOWLEDGE_UPDATE, params);
    },
    [rpcRef],
  );

  const loadChildThread = useCallback(
    async (childThreadId: string): Promise<ThreadReadResponse> => {
      const cached = childThreadCacheRef.current.get(childThreadId);
      if (cached) return cached;
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      const response = await rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.THREAD_READ, { threadId: childThreadId });
      childThreadCacheRef.current.set(childThreadId, response);
      return response;
    },
    [rpcRef, childThreadCacheRef],
  );

  const listMcpServers = useCallback(async (): Promise<McpListResponse> => {
    const rpc = rpcRef.current;
    if (!rpc) throw new Error("WebSocket is not connected");
    return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LIST, {
      threadId: state.activeThreadId ?? undefined,
    });
  }, [rpcRef, state.activeThreadId]);

  const mcpLoginStart = useCallback(
    async (server: string): Promise<McpLoginStartResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGIN_START, { server });
    },
    [rpcRef],
  );

  const mcpLogout = useCallback(
    async (server: string): Promise<McpLogoutResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("WebSocket is not connected");
      return rpc.request(DILIGENT_CLIENT_REQUEST_METHODS.MCP_LOGOUT, { server });
    },
    [rpcRef],
  );

  const threadTitle = useMemo(() => {
    const active = state.threadList.find((t) => t.id === state.activeThreadId);
    const raw = active?.firstUserMessage ?? state.items.find((i) => i.kind === "user")?.text ?? "";
    return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  }, [state.activeThreadId, state.threadList, state.items]);

  return {
    listTools,
    saveTools,
    listSkills,
    saveSkills,
    listSubagents,
    saveSubagents,
    listKnowledge,
    updateKnowledge,
    loadChildThread,
    listMcpServers,
    mcpLoginStart,
    mcpLogout,
    threadTitle,
  };
}
