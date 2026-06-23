// @summary React hook for provider authentication state, available models, and OAuth

import type { AuthOAuthStartResponse, ModelInfo, ProviderAuthStatus } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { cancelOAuthFlow, fetchProviderStatus, removeProviderKey, setProviderKey, startOAuthFlow } from "./auth-api";
import type { WebRpcClient } from "./rpc-client";

export function resolveDraftModel({
  initialModel,
  currentModel,
  availableModels,
}: {
  initialModel: string;
  currentModel: string;
  availableModels: ModelInfo[];
}): string {
  if (availableModels.some((model) => model.id === currentModel)) {
    return currentModel;
  }
  if (availableModels.some((model) => model.id === initialModel)) {
    return initialModel;
  }
  return availableModels[0]?.id ?? "";
}

export function useProviderManager(rpcRef: RefObject<WebRpcClient | null>) {
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<string>("");
  const [providerStatusResolved, setProviderStatusResolved] = useState(false);

  // Refs kept in sync so async callbacks always read the latest values
  const currentModelRef = useRef<string>("");
  currentModelRef.current = currentModel;
  const initialModelRef = useRef<string>("");
  const availableModelsRef = useRef<ModelInfo[]>([]);
  availableModelsRef.current = availableModels;

  // Syncs model (and optionally available models) into both state and refs immediately,
  // so subsequent async callbacks in the same chain see fresh values without waiting for re-render.
  const setInitialModel = useCallback((modelId: string, models?: ModelInfo[]): void => {
    setCurrentModel(modelId);
    currentModelRef.current = modelId;
    initialModelRef.current = modelId;
    if (models !== undefined) {
      setAvailableModels(models);
      availableModelsRef.current = models;
    }
  }, []);

  const resetDraftModel = useCallback((): void => {
    const nextModel = resolveDraftModel({
      initialModel: initialModelRef.current,
      currentModel: currentModelRef.current,
      availableModels: availableModelsRef.current,
    });
    setCurrentModel(nextModel);
    currentModelRef.current = nextModel;
  }, []);

  const refreshProviders = useCallback(
    async (rpc = rpcRef.current): Promise<void> => {
      if (!rpc) return;
      try {
        const result = await fetchProviderStatus(rpc);
        setProviders(result.providers);
        setAvailableModels(result.availableModels);
        const modelInvalid =
          result.availableModels.length > 0 && !result.availableModels.some((m) => m.id === currentModelRef.current);
        if (modelInvalid) {
          const first = result.availableModels[0];
          setCurrentModel(first.id);
          currentModelRef.current = first.id;
        }
      } catch (error) {
        console.error(error);
      } finally {
        setProviderStatusResolved(true);
      }
    },
    [rpcRef],
  );

  // Finds the last assistant model in history and applies it if valid and different from current.
  // Caller must ensure availableModelsRef is populated before calling (via setInitialModel).
  const applySessionModel = useCallback(async (sessionModel?: string): Promise<void> => {
    if (
      sessionModel &&
      sessionModel !== currentModelRef.current &&
      availableModelsRef.current.some((m) => m.id === sessionModel)
    ) {
      setCurrentModel(sessionModel);
      currentModelRef.current = sessionModel;
    }
  }, []);

  const changeModel = useCallback(
    async (modelId: string, threadId?: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      setCurrentModel(modelId);
      currentModelRef.current = modelId;
      try {
        await rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, { model: modelId, threadId });
      } catch (error) {
        console.error(error);
      }
    },
    [rpcRef],
  );

  const handleSetProviderKey = useCallback(
    async (provider: string, apiKey: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await setProviderKey(rpc, provider, apiKey);
      // account/updated notification will update providers state
    },
    [rpcRef],
  );

  const handleRemoveProviderKey = useCallback(
    async (provider: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      await removeProviderKey(rpc, provider);
      // account/updated notification will update providers state
    },
    [rpcRef],
  );

  const handleOAuthStart = useCallback(
    async (provider: string): Promise<AuthOAuthStartResponse> => {
      const rpc = rpcRef.current;
      if (!rpc) throw new Error("Not connected");
      if (provider !== "chatgpt") {
        throw new Error("OAuth login is only supported for chatgpt provider");
      }
      return startOAuthFlow(rpc, provider);
    },
    [rpcRef],
  );

  const handleOAuthCancel = useCallback(
    async (provider: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      if (provider !== "chatgpt") return;
      await cancelOAuthFlow(rpc, provider);
    },
    [rpcRef],
  );

  // Notification handlers: called from App.tsx when server pushes account notifications
  const onAccountLoginCompleted = useCallback(
    (params: { loginId: string | null; success: boolean; error: string | null }): void => {
      if (!params.success && params.error) {
        console.error("OAuth login failed:", params.error);
      }
      // Provider list update comes via onAccountUpdated
    },
    [],
  );

  const onAccountUpdated = useCallback(
    async (params: { providers: ProviderAuthStatus[] }): Promise<void> => {
      setProviders(params.providers);
      setProviderStatusResolved(true);
      // Also refresh available models since provider configuration changed
      const rpc = rpcRef.current;
      if (!rpc) return;
      try {
        const result = await fetchProviderStatus(rpc);
        setAvailableModels(result.availableModels);
        const modelInvalid =
          result.availableModels.length > 0 && !result.availableModels.some((m) => m.id === currentModelRef.current);
        if (modelInvalid) {
          const first = result.availableModels[0];
          setCurrentModel(first.id);
          currentModelRef.current = first.id;
        }
      } catch {
        // Non-critical: providers already updated via notification
      }
    },
    [rpcRef],
  );

  const hasProvider = useMemo(() => providers.some((p) => p.configured), [providers]);
  const effectiveHasProvider = useMemo(
    () => providers.some((p) => p.configured) || !providerStatusResolved,
    [providers, providerStatusResolved],
  );
  const contextWindow = useMemo(
    () => availableModels.find((m) => m.id === currentModel)?.contextWindow ?? 0,
    [availableModels, currentModel],
  );

  return {
    providers,
    providerStatusResolved,
    availableModels,
    currentModel,
    currentModelRef,
    availableModelsRef,
    setInitialModel,
    resetDraftModel,
    refreshProviders,
    applySessionModel,
    changeModel,
    handleSetProviderKey,
    handleRemoveProviderKey,
    handleOAuthStart,
    handleOAuthCancel,
    onAccountLoginCompleted,
    onAccountUpdated,
    hasProvider,
    effectiveHasProvider,
    contextWindow,
  };
}
