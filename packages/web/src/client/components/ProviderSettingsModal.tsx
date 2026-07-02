// @summary Modal for managing provider authentication (API keys and ChatGPT OAuth)

import type { ProviderAuthStatus } from "@diligent/protocol";
import { useCallback, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Modal } from "./Modal";
import { StatusDot } from "./StatusDot";
import { actionRowClasses, cardPaddingClasses, itemStackClasses, surfaceCardClasses } from "./ui-styles";

interface ProviderSettingsModalProps {
  providers: ProviderAuthStatus[];
  focusProvider?: string;
  oauthPending: boolean;
  oauthError: string | null;
  onSet: (provider: string, apiKey: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
  onOAuthStart: (provider: string) => Promise<{ authUrl: string }>;
  onOAuthCancel?: (provider: string) => Promise<void>;
  onClose: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  chatgpt: "ChatGPT",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  vertex: "Vertex AI",
  "zai-coding-plan": "z.ai Coding Plan",
};

const PROVIDER_INPUT_PLACEHOLDERS: Record<string, string> = {
  anthropic: "API key",
  openai: "API key",
  chatgpt: "API key",
  "gemini-3.1-pro": "API key",
  "gemini-3-flash": "API key",
  "gemini-3.1-flash-lite": "API key",
  vertex: "Google Cloud access token",
  "zai-coding-plan": "API key",
};

export function ProviderSettingsModal({
  providers,
  focusProvider,
  oauthPending,
  oauthError,
  onSet,
  onRemove,
  onOAuthStart,
  onOAuthCancel,
  onClose,
}: ProviderSettingsModalProps) {
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (provider: string) => {
    if (!keyInput.trim()) return;
    setSavingProvider(provider);
    setError(null);
    try {
      await onSet(provider, keyInput.trim());
      setEditingProvider(null);
      setKeyInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save key");
    } finally {
      setSavingProvider(null);
    }
  };

  const handleDisconnect = async (provider: string) => {
    setSavingProvider(provider);
    setError(null);
    try {
      await onRemove(provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove key");
    } finally {
      setSavingProvider(null);
    }
  };

  const handleCancel = () => {
    setEditingProvider(null);
    setKeyInput("");
    setError(null);
  };

  const handleOAuthStart = useCallback(async () => {
    setError(null);
    try {
      await onOAuthStart("chatgpt");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [onOAuthStart]);

  const handleOAuthCancel = useCallback(async () => {
    if (!onOAuthCancel) return;
    setError(null);
    try {
      await onOAuthCancel("chatgpt");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel OAuth");
    }
  }, [onOAuthCancel]);

  const isConnected = (p: ProviderAuthStatus) => p.configured || p.oauthConnected;
  // Vertex needs project/location/endpoint config that this token-only UI can't express, so it's
  // hidden here for now — configure it via provider.vertex in config.jsonc instead. (Config-file
  // Vertex still works and its models still appear in the picker.)
  const visibleProviders = providers.filter((provider) => provider.provider !== "vertex");
  const orderedProviders = [
    ...visibleProviders.filter((provider) => provider.provider === "chatgpt"),
    ...visibleProviders.filter((provider) => provider.provider !== "chatgpt"),
  ];

  // Display combined error from local state or OAuth notification
  const displayError = error || oauthError;

  return (
    <Modal
      title="Connect AI"
      description="For most users, start with ChatGPT (browser login). You can also connect other providers with API keys."
      onCancel={onClose}
    >
      <div className={itemStackClasses}>
        {orderedProviders.map((p) => {
          const isSaving = savingProvider === p.provider;
          const isFocused = focusProvider === p.provider;
          return (
            <div
              key={p.provider}
              className={`${surfaceCardClasses} ${cardPaddingClasses} ${
                isFocused ? "border-accent/40 bg-fill-ghost-hover" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <StatusDot color={isConnected(p) ? "success" : "danger"} size="md" />
                <span className="flex-1 text-sm font-medium text-text">
                  {PROVIDER_LABELS[p.provider] ?? p.provider}
                </span>
                {p.maskedKey ? <span className="font-mono text-xs text-muted">{p.maskedKey}</span> : null}
                {p.oauthConnected ? <span className="font-mono text-xs text-muted">OAuth</span> : null}
                {editingProvider !== p.provider && !oauthPending ? (
                  isConnected(p) || isSaving ? (
                    <Button
                      intent="ghost"
                      size="sm"
                      disabled={isSaving}
                      onClick={() => void handleDisconnect(p.provider)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      intent="ghost"
                      size="sm"
                      onClick={() => {
                        if (p.provider === "chatgpt") {
                          void handleOAuthStart();
                        } else {
                          setEditingProvider(p.provider);
                          setKeyInput("");
                          setError(null);
                        }
                      }}
                    >
                      {p.provider === "chatgpt" ? "Sign in" : "Connect"}
                    </Button>
                  )
                ) : null}
              </div>

              {p.provider === "chatgpt" && !isConnected(p) ? (
                <div className="mt-2 text-xs text-muted">Recommended first setup — no API key needed.</div>
              ) : null}
              {p.provider === "vertex" ? (
                <div className="mt-2 text-xs text-muted">
                  Use a Google Cloud access token here, or configure ADC in runtime config.
                </div>
              ) : null}

              {editingProvider === p.provider ? (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder={PROVIDER_INPUT_PLACEHOLDERS[p.provider] ?? "API key"}
                      className="h-8"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSave(p.provider);
                        if (e.key === "Escape") handleCancel();
                      }}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      disabled={isSaving || !keyInput.trim()}
                      onClick={() => void handleSave(p.provider)}
                    >
                      Save
                    </Button>
                    <Button intent="ghost" size="sm" disabled={isSaving} onClick={handleCancel}>
                      Cancel
                    </Button>
                  </div>
                  {p.provider === "chatgpt" ? (
                    <div className="flex items-center gap-2">
                      <Button
                        intent="ghost"
                        size="sm"
                        disabled={isSaving || oauthPending}
                        onClick={() => void handleOAuthStart()}
                      >
                        {oauthPending ? "Waiting for login..." : "Login with ChatGPT"}
                      </Button>
                      {oauthPending && onOAuthCancel ? (
                        <Button intent="ghost" size="sm" onClick={() => void handleOAuthCancel()}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {p.provider === "chatgpt" && oauthPending && editingProvider !== p.provider ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="animate-pulse text-xs text-accent">Waiting for ChatGPT login...</span>
                  {onOAuthCancel ? (
                    <Button intent="ghost" size="sm" onClick={() => void handleOAuthCancel()}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        {displayError ? <p className="text-sm text-danger">{displayError}</p> : null}
      </div>

      <div className={`mt-4 ${actionRowClasses}`}>
        <Button intent="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
