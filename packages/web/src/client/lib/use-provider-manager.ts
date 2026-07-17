// @summary React hook for provider authentication state, available models, and OAuth

import { createLogger } from "@diligent/logging";
import type { AuthOAuthStartResponse, ModelInfo, ModelRef, ProviderAuthStatus } from "@diligent/protocol";
import { DILIGENT_CLIENT_REQUEST_METHODS } from "@diligent/protocol";
import type { RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { cancelOAuthFlow, fetchProviderStatus, removeProviderKey, setProviderKey, startOAuthFlow } from "./auth-api";
import { findModelInfo, sameModelRef } from "./model-thinking-helpers";
import type { WebRpcClient } from "./rpc-client";

const logger = createLogger({ scope: "web.client.providers" });

export function resolveDraftModel({
  initialModel,
  currentModel,
  availableModels,
}: {
  initialModel: ModelRef | undefined;
  currentModel: ModelRef | undefined;
  availableModels: ModelInfo[];
}): ModelRef | undefined {
  if (findModelInfo(availableModels, currentModel)) {
    return currentModel;
  }
  if (findModelInfo(availableModels, initialModel)) {
    return initialModel;
  }
  return availableModels[0];
}

export function useProviderManager(rpcRef: RefObject<WebRpcClient | null>) {
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelRef | undefined>();
  const [providerStatusResolved, setProviderStatusResolved] = useState(false);

  // Refs kept in sync so async callbacks always read the latest values
  const currentModelRef = useRef<ModelRef | undefined>(undefined);
  currentModelRef.current = currentModel;
  const initialModelRef = useRef<ModelRef | undefined>(undefined);
  const availableModelsRef = useRef<ModelInfo[]>([]);
  availableModelsRef.current = availableModels;

  // Syncs model (and optionally available models) into both state and refs immediately,
  // so subsequent async callbacks in the same chain see fresh values without waiting for re-render.
  const setInitialModel = useCallback((model: ModelRef | undefined, models?: ModelInfo[]): void => {
    setCurrentModel(model);
    currentModelRef.current = model;
    initialModelRef.current = model;
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
          result.availableModels.length > 0 && !findModelInfo(result.availableModels, currentModelRef.current);
        if (modelInvalid) {
          const nextModel = resolveDraftModel({
            initialModel: initialModelRef.current,
            currentModel: currentModelRef.current,
            availableModels: result.availableModels,
          });
          setCurrentModel(nextModel);
          currentModelRef.current = nextModel;
        }
      } catch (error) {
        logger.error("providers.refresh_failed", {
          message: "Failed to refresh provider status",
          error,
        });
      } finally {
        setProviderStatusResolved(true);
      }
    },
    [rpcRef],
  );

  // Finds the last assistant model in history and applies it if valid and different from current.
  // Caller must ensure availableModelsRef is populated before calling (via setInitialModel).
  const applySessionModel = useCallback(async (sessionModel?: ModelRef): Promise<void> => {
    if (
      sessionModel &&
      !sameModelRef(sessionModel, currentModelRef.current) &&
      findModelInfo(availableModelsRef.current, sessionModel)
    ) {
      setCurrentModel(sessionModel);
      currentModelRef.current = sessionModel;
    }
  }, []);

  const changeModel = useCallback(
    async (model: ModelRef, threadId?: string): Promise<void> => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      setCurrentModel(model);
      currentModelRef.current = model;
      try {
        await rpc.webRequest(DILIGENT_CLIENT_REQUEST_METHODS.CONFIG_SET, { model, threadId });
      } catch (error) {
        logger.error("model.change_failed", {
          message: "Failed to change model",
          error,
          threadId,
          fields: { model },
        });
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
        logger.error("oauth.login_failed", {
          message: `OAuth login failed: ${params.error}`,
          error: params.error,
          fields: { loginId: params.loginId },
        });
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
          result.availableModels.length > 0 && !findModelInfo(result.availableModels, currentModelRef.current);
        if (modelInvalid) {
          const nextModel = resolveDraftModel({
            initialModel: initialModelRef.current,
            currentModel: currentModelRef.current,
            availableModels: result.availableModels,
          });
          setCurrentModel(nextModel);
          currentModelRef.current = nextModel;
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
    () => findModelInfo(availableModels, currentModel)?.contextWindow ?? 0,
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
