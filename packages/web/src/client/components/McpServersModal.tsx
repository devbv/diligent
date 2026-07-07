// @summary Modal listing configured MCP servers with OAuth login/logout via shared RPC methods (P070)

import type { McpListResponse, McpLoginStartResponse, McpLogoutResponse, McpServerStatus } from "@diligent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { X } from "./icons";
import { StatusDot } from "./StatusDot";
import {
  cardPaddingClasses,
  itemStackClasses,
  panelBodyClasses,
  panelCloseButtonClasses,
  panelFooterClasses,
  panelFrameClasses,
  panelHeaderClasses,
  surfaceCardClasses,
} from "./ui-styles";

interface McpServersModalProps {
  /** Pre-loaded state for tests/storybook; when omitted the modal fetches via `onList`. */
  initialState?: McpListResponse;
  /** Increments when an `mcp/login/completed` notification arrives, triggering a re-fetch. */
  refreshSignal?: number;
  onList: () => Promise<McpListResponse>;
  onLoginStart: (server: string) => Promise<McpLoginStartResponse>;
  onLogout: (server: string) => Promise<McpLogoutResponse>;
  onClose: () => void;
  className?: string;
}

const STATUS_DOT: Record<McpServerStatus["status"], "success" | "accent" | "danger"> = {
  connected: "success",
  needs_auth: "accent",
  error: "danger",
  disabled: "accent",
};

function statusDetail(server: McpServerStatus): string {
  switch (server.status) {
    case "connected":
      return `${server.transport} • ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    case "needs_auth":
      return `${server.transport} • needs login`;
    case "disabled":
      return `${server.transport} • disabled`;
    default:
      return `${server.transport} • error`;
  }
}

export function McpServersModal({
  initialState,
  refreshSignal,
  onList,
  onLoginStart,
  onLogout,
  onClose,
  className,
}: McpServersModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<McpListResponse | null>(initialState ?? null);
  const [loading, setLoading] = useState(!initialState);
  const [error, setError] = useState<string | null>(null);
  const [busyServer, setBusyServer] = useState<string | null>(null);
  // Server that has an interactive login in flight. The app-server opens the browser and drives the
  // OAuth flow; completion arrives via the `mcp/login/completed` notification (bumping refreshSignal).
  const [awaitingServer, setAwaitingServer] = useState<string | null>(null);
  // Authorization URL as a manual fallback, in case the server-side browser launch is unavailable.
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setState(await onList());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load MCP servers");
    }
  }, [onList]);

  useEffect(() => {
    if (initialState) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void onList()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load MCP servers");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialState, onList]);

  // Re-fetch when a login completes elsewhere (notification-driven refresh). Skips first render.
  const firstRefresh = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSignal is the intentional trigger
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    // A completed (or failed) login clears the waiting state; the refreshed list reflects the outcome.
    setAwaitingServer(null);
    setManualUrl(null);
    void refresh();
  }, [refreshSignal, refresh]);

  const handleLogin = async (server: string): Promise<void> => {
    setBusyServer(server);
    setError(null);
    try {
      // The app-server opens the browser itself (consistent with TUI and provider OAuth), so we do
      // not call window.open here. The returned URL is kept only as a manual fallback link.
      const { authUrl } = await onLoginStart(server);
      setAwaitingServer(server);
      setManualUrl(authUrl || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start login");
    } finally {
      setBusyServer(null);
    }
  };

  const handleLogout = async (server: string): Promise<void> => {
    setBusyServer(server);
    setError(null);
    try {
      await onLogout(server);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to log out");
    } finally {
      setBusyServer(null);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.key !== "Escape") return;
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
        aria-label="MCP Servers"
        tabIndex={-1}
        className={panelFrameClasses}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={panelHeaderClasses}>
          <div>
            <h2 className="text-lg font-semibold text-text">MCP Servers</h2>
            <p className="mt-1 text-sm text-muted">Manage configured MCP servers and their authentication.</p>
          </div>
          <button
            type="button"
            aria-label="Close MCP servers panel"
            onClick={onClose}
            className={panelCloseButtonClasses}
          >
            <X className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        <div className={panelBodyClasses}>
          {loading ? <p className="text-sm text-muted">Loading MCP servers…</p> : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {state && state.servers.length === 0 ? (
            <p className="text-sm text-muted">
              No MCP servers configured. Add them under `mcpServers` in config.jsonc.
            </p>
          ) : null}

          {state && state.servers.length > 0 ? (
            <div className={itemStackClasses}>
              {state.servers.map((server) => {
                const busy = busyServer === server.name;
                return (
                  <div
                    key={server.name}
                    className={`${surfaceCardClasses} ${cardPaddingClasses} flex items-center gap-3`}
                  >
                    <StatusDot color={STATUS_DOT[server.status]} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text">{server.name}</div>
                      <p className="mt-0.5 text-xs text-muted">{statusDetail(server)}</p>
                      {server.error ? <p className="mt-1 text-xs text-danger">{server.error}</p> : null}
                    </div>
                    {server.transport === "stdio" ? null : awaitingServer === server.name ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="animate-pulse text-xs text-accent">Waiting for login…</span>
                        {manualUrl ? (
                          <a
                            href={manualUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted underline hover:text-text"
                          >
                            Open link manually
                          </a>
                        ) : null}
                      </div>
                    ) : server.status === "needs_auth" ? (
                      <Button size="sm" intent="info" disabled={busy} onClick={() => void handleLogin(server.name)}>
                        {busy ? "Opening…" : "Login"}
                      </Button>
                    ) : server.status === "connected" ? (
                      <Button size="sm" intent="ghost" disabled={busy} onClick={() => void handleLogout(server.name)}>
                        {busy ? "…" : "Logout"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className={panelFooterClasses}>
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
