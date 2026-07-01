// @summary Modal for listing and updating built-in tool/plugin settings through shared RPC methods

import type {
  ConsentSetParams,
  ConsentState,
  ProviderAuthStatus,
  ToolsListResponse,
  ToolsSetParams,
  ToolsSetResponse,
} from "@diligent/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import {
  badgeClasses,
  cardPaddingClasses,
  cardPaddingLooseClasses,
  controlRowClasses,
  itemStackClasses,
  panelBodyClasses,
  panelCloseButtonClasses,
  panelFooterClasses,
  panelFrameClasses,
  panelHeaderClasses,
  sectionStackClasses,
  surfaceCardClasses,
} from "./ui-styles";

const PROVIDER_BADGE_STYLE: Record<string, string> = {
  anthropic: "border-provider-anthropic/30 bg-provider-anthropic/10 text-provider-anthropic",
  openai: "border-provider-openai/30 bg-provider-openai/10 text-provider-openai",
  chatgpt: "border-provider-chatgpt/30 bg-provider-chatgpt/10 text-provider-chatgpt",
  gemini: "border-provider-gemini/30 bg-provider-gemini/10 text-provider-gemini",
  vertex: "border-provider-vertex/30 bg-provider-vertex/10 text-provider-vertex",
  "zai-coding-plan": "border-provider-zaicodingplan/30 bg-provider-zaicodingplan/10 text-provider-zaicodingplan",
};

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

interface ToolSettingsModalProps {
  threadId?: string | null;
  runtimeVersion?: string;
  initialState?: ToolsListResponse;
  providers?: ProviderAuthStatus[];
  desktopNotificationsEnabled?: boolean;
  consent?: ConsentState | null;
  onConsentChange?: (patch: ConsentSetParams) => void | Promise<void>;
  onList: (threadId?: string) => Promise<ToolsListResponse>;
  onSave: (params: ToolsSetParams) => Promise<ToolsSetResponse>;
  onDesktopNotificationsEnabledChange?: (enabled: boolean) => void;
  onOpenProviders?: () => void;
  onClose: () => void;
  className?: string;
}

interface PluginDraft {
  package: string;
  enabled: boolean;
  tools: Record<string, boolean>;
}

interface ToolSettingsDraft {
  builtin: Record<string, boolean>;
  plugins: PluginDraft[];
  removedPackages: string[];
}

function createDraft(state: ToolsListResponse): ToolSettingsDraft {
  return {
    builtin: Object.fromEntries(
      state.tools
        .filter((tool) => tool.source === "builtin" && tool.configurable)
        .map((tool) => [tool.name, tool.enabled]),
    ),
    plugins: state.plugins.map((plugin) => ({
      package: plugin.package,
      enabled: plugin.enabled,
      tools: Object.fromEntries(
        state.tools
          .filter((tool) => tool.source === "plugin" && tool.pluginPackage === plugin.package)
          .map((tool) => [tool.name, tool.enabled]),
      ),
    })),
    removedPackages: [],
  };
}

function buildSetParams(threadId: string | null | undefined, draft: ToolSettingsDraft): ToolsSetParams {
  const params: ToolsSetParams = {};
  if (threadId) {
    params.threadId = threadId;
  }
  if (Object.keys(draft.builtin).length > 0) {
    params.builtin = draft.builtin;
  }
  const plugins = [
    ...draft.plugins.map((plugin) => ({
      package: plugin.package,
      enabled: plugin.enabled,
      tools: plugin.tools,
    })),
    ...draft.removedPackages.map((pkg) => ({ package: pkg, remove: true as const })),
  ];
  if (plugins.length > 0) {
    params.plugins = plugins;
  }
  return params;
}

function describeToolReason(tool: ToolsListResponse["tools"][number]): string {
  switch (tool.reason) {
    case "enabled":
      return tool.enabled ? "Enabled" : "Unavailable";
    case "disabled_by_user":
      return "Disabled in settings";
    case "immutable_forced_on":
      return "Always enabled";
    case "plugin_disabled":
      return "Disabled because the package is off";
    case "plugin_load_failed":
      return "Unavailable because the package failed to load";
    case "conflict_dropped":
      return "Dropped because another tool already uses this name";
    case "invalid_plugin_tool":
      return "Rejected because the plugin returned an invalid tool";
    case "superseded_by_bundled":
      return "Superseded by a bundled product tool";
  }
}

function pluginSummary(plugin: ToolsListResponse["plugins"][number]): string {
  if (plugin.loadError) {
    return `Load failed: ${plugin.loadError}`;
  }
  if (plugin.warnings.length > 0) {
    return plugin.warnings[0] ?? "Warnings reported";
  }
  if (!plugin.loaded) {
    return "Configured. Save to attempt loading on the next refresh.";
  }
  if (plugin.toolCount === 0) {
    return "Loaded with no tools.";
  }
  return `${plugin.toolCount} tool${plugin.toolCount === 1 ? "" : "s"}`;
}

export function ToolSettingsModal({
  threadId,
  runtimeVersion,
  initialState,
  providers,
  desktopNotificationsEnabled,
  consent,
  onConsentChange,
  onList,
  onSave,
  onDesktopNotificationsEnabledChange,
  onOpenProviders,
  onClose,
  className,
}: ToolSettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ToolsListResponse | null>(initialState ?? null);
  const [draft, setDraft] = useState<ToolSettingsDraft | null>(initialState ? createDraft(initialState) : null);
  const [loading, setLoading] = useState(!initialState);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [newPackageName, setNewPackageName] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialState) {
      setState(initialState);
      setDraft(createDraft(initialState));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void onList(threadId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setDraft(createDraft(result));
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load tool settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialState, onList, threadId]);

  const pluginToolsByPackage = useMemo(() => {
    if (!state) return new Map<string, ToolsListResponse["tools"]>();
    const groups = new Map<string, ToolsListResponse["tools"]>();
    for (const tool of state.tools) {
      if (tool.source !== "plugin" || !tool.pluginPackage) continue;
      const existing = groups.get(tool.pluginPackage) ?? [];
      existing.push(tool);
      groups.set(tool.pluginPackage, existing);
    }
    return groups;
  }, [state]);

  const currentPluginDrafts = draft?.plugins ?? [];
  const connectedProviders = (providers ?? []).filter((provider) => provider.configured || provider.oauthConnected);

  const handleBuiltinToggle = (name: string, enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        builtin: {
          ...current.builtin,
          [name]: enabled,
        },
      };
    });
  };

  const handlePluginToggle = (pkg: string, enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        plugins: current.plugins.map((plugin) => (plugin.package === pkg ? { ...plugin, enabled } : plugin)),
      };
    });
  };

  const handlePluginToolToggle = (pkg: string, toolName: string, enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        plugins: current.plugins.map((plugin) =>
          plugin.package === pkg
            ? {
                ...plugin,
                tools: {
                  ...plugin.tools,
                  [toolName]: enabled,
                },
              }
            : plugin,
        ),
      };
    });
  };

  const handleRemovePlugin = (pkg: string) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        plugins: current.plugins.filter((plugin) => plugin.package !== pkg),
        removedPackages: current.removedPackages.includes(pkg)
          ? current.removedPackages
          : [...current.removedPackages, pkg],
      };
    });
    setSavedMessage(null);
  };

  const handleAddPlugin = () => {
    const pkg = newPackageName.trim();
    if (!pkg || !draft) return;
    if (draft.plugins.some((plugin) => plugin.package === pkg)) {
      setError(`Package already exists: ${pkg}`);
      return;
    }

    setDraft({
      ...draft,
      plugins: [...draft.plugins, { package: pkg, enabled: true, tools: {} }],
      removedPackages: draft.removedPackages.filter((entry) => entry !== pkg),
    });
    setNewPackageName("");
    setError(null);
    setSavedMessage(null);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      await onSave(buildSetParams(threadId, draft));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save tool settings");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Escape") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    onClose();
  };

  return (
    <div className={className ?? "fixed inset-0 z-50 bg-overlay/35"} role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Config"
        tabIndex={-1}
        className={panelFrameClasses}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={panelHeaderClasses}>
          <div>
            <h2 className="text-lg font-semibold text-text">Config</h2>
            <p className="mt-1 text-sm text-muted">Manage built-in tools and trusted JavaScript plugin packages.</p>
          </div>
          <button type="button" aria-label="Close tools panel" onClick={onClose} className={panelCloseButtonClasses}>
            ✕
          </button>
        </div>

        <div className={panelBodyClasses}>
          {loading ? <p className="text-sm text-muted">Loading tool settings…</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {savedMessage ? <p className="text-sm text-accent">{savedMessage}</p> : null}

          {state && draft ? (
            <div className="space-y-4">
              {onOpenProviders ? (
                <section className={sectionStackClasses}>
                  <div>
                    <h3 className="text-sm font-semibold text-text">AI connection</h3>
                    <p className="text-xs text-muted">Manage your connected AI accounts and login methods.</p>
                  </div>
                  <div className={`${surfaceCardClasses} ${cardPaddingClasses}`}>
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      {connectedProviders.length > 0 ? (
                        connectedProviders.map((provider) => (
                          <span
                            key={provider.provider}
                            className={`${badgeClasses} ${
                              PROVIDER_BADGE_STYLE[provider.provider] ?? "border-border/100 bg-surface-light text-text"
                            }`}
                          >
                            {PROVIDER_LABELS[provider.provider] ?? provider.provider}
                            {provider.oauthConnected ? " (OAuth)" : ""}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-muted">No provider connected</span>
                      )}
                    </div>
                    <Button intent="ghost" size="sm" onClick={onOpenProviders}>
                      Open AI connection settings
                    </Button>
                  </div>
                </section>
              ) : null}

              {typeof desktopNotificationsEnabled === "boolean" && onDesktopNotificationsEnabledChange ? (
                <section className={sectionStackClasses}>
                  <div>
                    <h3 className="text-sm font-semibold text-text">Desktop notifications</h3>
                    <p className="text-xs text-muted">
                      Show native OS notifications for background turn completion and pending approval/input requests.
                    </p>
                  </div>
                  <label className={controlRowClasses}>
                    <input
                      type="checkbox"
                      checked={desktopNotificationsEnabled}
                      onChange={(event) => onDesktopNotificationsEnabledChange(event.target.checked)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text">Enable desktop notifications</div>
                      <p className="mt-0.5 text-xs text-muted">
                        Only notifies while the desktop app is not foregrounded.
                      </p>
                    </div>
                  </label>
                </section>
              ) : null}

              {consent && onConsentChange ? (
                <section className={sectionStackClasses}>
                  <div>
                    <h3 className="text-sm font-semibold text-text">AI Agent Data Use</h3>
                    <p className="text-xs text-muted">Control how your conversations with the AI agent are used.</p>
                    <a
                      href={consent.privacyPolicyUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 inline-flex text-sm text-text-soft underline underline-offset-2 hover:text-text"
                    >
                      View Privacy Policy ›
                    </a>
                  </div>
                  <label className={controlRowClasses}>
                    <input
                      type="checkbox"
                      checked={consent.serviceImprovement}
                      onChange={(event) => void onConsentChange({ serviceImprovement: event.target.checked })}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text">Improve service with your chats</div>
                      <p className="mt-0.5 text-xs text-muted">
                        We use your conversations with the AI agent to operate the service, improve quality, and
                        diagnose errors. This data is not used to train AI models.
                      </p>
                      <p className="mt-1 text-xs text-muted">Default On · Turning off stops improvement use</p>
                    </div>
                  </label>
                </section>
              ) : null}

              <section className={sectionStackClasses}>
                <div>
                  <h3 className="text-sm font-semibold text-text">Runtime version</h3>
                  <p className="text-xs text-muted">Version of the runtime currently connected to this web client.</p>
                </div>
                <div className={`${surfaceCardClasses} ${cardPaddingClasses}`}>
                  <div className="text-sm font-medium text-text">
                    {runtimeVersion?.trim() ? runtimeVersion : "Unavailable"}
                  </div>
                </div>
              </section>

              <section className={sectionStackClasses}>
                <div>
                  <h3 className="text-sm font-semibold text-text">Built-in tools</h3>
                  <p className="text-xs text-muted">
                    Immutable tools stay enabled even if config tries to turn them off.
                  </p>
                </div>
                <div className={itemStackClasses}>
                  {state.tools
                    .filter((tool) => tool.source === "builtin")
                    .map((tool) => {
                      const checked = tool.configurable ? (draft.builtin[tool.name] ?? tool.enabled) : true;
                      const disabled = !tool.configurable || tool.immutable;
                      return (
                        <label key={tool.name} className={controlRowClasses}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(event) => handleBuiltinToggle(tool.name, event.target.checked)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text">{tool.name}</span>
                              {tool.immutable ? (
                                <span className={`${badgeClasses} border-border/100 bg-surface-light text-muted`}>
                                  Locked
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 text-xs text-muted">{describeToolReason(tool)}</p>
                            {tool.error ? <p className="mt-1 text-xs text-danger">{tool.error}</p> : null}
                          </div>
                        </label>
                      );
                    })}
                </div>
              </section>

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-text">Plugin packages</h3>
                  <p className="text-xs text-muted">
                    Packages must already be installed and resolvable from this project.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Plugin package name"
                    className="min-w-0 flex-1"
                    placeholder="@acme/diligent-tools"
                    value={newPackageName}
                    onChange={(event) => setNewPackageName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleAddPlugin();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    intent="ghost"
                    className="min-w-28 shrink-0 whitespace-nowrap"
                    disabled={!newPackageName.trim()}
                    onClick={handleAddPlugin}
                  >
                    Add Package
                  </Button>
                </div>

                {currentPluginDrafts.length === 0 ? (
                  <div className={`${surfaceCardClasses} border-dashed ${cardPaddingLooseClasses} text-sm text-muted`}>
                    No plugin packages configured.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {currentPluginDrafts.map((pluginDraft) => {
                      const pluginState = state.plugins.find((plugin) => plugin.package === pluginDraft.package);
                      const pluginTools = pluginToolsByPackage.get(pluginDraft.package) ?? [];
                      const canShowRuntimeState = Boolean(pluginState);
                      return (
                        <div key={pluginDraft.package} className={`${surfaceCardClasses} ${cardPaddingLooseClasses}`}>
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={pluginDraft.enabled}
                              onChange={(event) => handlePluginToggle(pluginDraft.package, event.target.checked)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-text">{pluginDraft.package}</span>
                                {!pluginState ? (
                                  <span className={`${badgeClasses} border-accent/30 bg-fill-ghost-hover text-accent`}>
                                    Pending save
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-0.5 text-xs text-muted">
                                {pluginState
                                  ? pluginSummary(pluginState)
                                  : "New package. Save to load and inspect its tools."}
                              </p>
                              {pluginState?.loadError ? (
                                <p className="mt-1 text-xs text-danger">{pluginState.loadError}</p>
                              ) : null}
                              {pluginState?.warnings.map((warning) => (
                                <p key={warning} className="mt-1 text-xs text-warning">
                                  {warning}
                                </p>
                              ))}
                            </div>
                            <Button size="sm" intent="ghost" onClick={() => handleRemovePlugin(pluginDraft.package)}>
                              Remove
                            </Button>
                          </div>

                          {canShowRuntimeState && pluginTools.length > 0 ? (
                            <div className="mt-3 space-y-2 border-t border-border/10 pt-3">
                              {pluginTools.map((tool) => {
                                const checked = pluginDraft.tools[tool.name] ?? tool.enabled;
                                const disabled = !tool.configurable || !tool.available;
                                return (
                                  <label key={tool.name} className={`${controlRowClasses} bg-surface-default`}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={disabled}
                                      onChange={(event) =>
                                        handlePluginToolToggle(pluginDraft.package, tool.name, event.target.checked)
                                      }
                                      className="mt-0.5"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium text-text">{tool.name}</div>
                                      <p className="mt-0.5 text-xs text-muted">{describeToolReason(tool)}</p>
                                      {tool.error ? <p className="mt-1 text-xs text-danger">{tool.error}</p> : null}
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>

        <div className={panelFooterClasses}>
          <Button intent="ghost" size="sm" disabled={saving} onClick={onClose}>
            Close
          </Button>
          <Button size="sm" disabled={loading || saving || !draft} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { buildSetParams, createDraft };
export type { ToolSettingsDraft };
