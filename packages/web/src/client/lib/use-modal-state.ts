// @summary Modal visibility, OAuth, and provider interaction state hook
import { useCallback, useState } from "react";
import type { useProviderManager } from "./use-provider-manager";

type ProviderMgrResult = ReturnType<typeof useProviderManager>;

export function useModalState({ providerMgr }: { providerMgr: ProviderMgrResult }) {
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showToolModal, setShowToolModal] = useState(false);
  const [showKnowledgeModal, setShowKnowledgeModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusedProvider, setFocusedProvider] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const closeModals = useCallback(() => {
    setShowKnowledgeModal(false);
    setShowToolModal(false);
  }, []);

  const handleOpenProviders = useCallback(() => {
    setFocusedProvider(null);
    setShowProviderModal(true);
  }, []);

  const handleProviderModalClose = useCallback(() => {
    setShowProviderModal(false);
    setFocusedProvider(null);
    setOauthError(null);
  }, []);

  const handleProviderOAuthStart = useCallback(
    async (provider: string): Promise<{ authUrl: string }> => {
      setOauthPending(true);
      setOauthError(null);
      const result = await providerMgr.handleOAuthStart(provider);
      return result;
    },
    [providerMgr],
  );

  const handleProviderOAuthCancel = useCallback(
    async (provider: string): Promise<void> => {
      await providerMgr.handleOAuthCancel(provider);
    },
    [providerMgr],
  );

  const handleQuickConnectChatGPT = useCallback(() => {
    setOauthPending(true);
    setOauthError(null);
    void providerMgr.handleOAuthStart("chatgpt").catch((error) => {
      setOauthPending(false);
      setOauthError(error instanceof Error ? error.message : "Failed to start OAuth");
      setFocusedProvider("chatgpt");
      setShowProviderModal(true);
    });
  }, [providerMgr]);

  return {
    showProviderModal,
    setShowProviderModal,
    showToolModal,
    setShowToolModal,
    showKnowledgeModal,
    setShowKnowledgeModal,
    sidebarOpen,
    setSidebarOpen,
    focusedProvider,
    setFocusedProvider,
    oauthPending,
    setOauthPending,
    oauthError,
    setOauthError,
    closeModals,
    handleOpenProviders,
    handleProviderModalClose,
    handleProviderOAuthStart,
    handleProviderOAuthCancel,
    handleQuickConnectChatGPT,
  };
}
