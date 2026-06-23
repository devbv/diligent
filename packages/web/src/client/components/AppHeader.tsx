// @summary Top navigation bar: sidebar toggle, thread status, title, and tool/knowledge buttons

interface AppHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  threadStatus: string | null;
  isCompacting: boolean;
  threadTitle: string;
  onOpenKnowledge: () => void;
  onOpenConfig: () => void;
}

export function AppHeader({
  sidebarOpen,
  onToggleSidebar,
  threadStatus,
  isCompacting,
  threadTitle,
  onOpenKnowledge,
  onOpenConfig,
}: AppHeaderProps) {
  return (
    <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border/100 bg-surface-dark px-3">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-surface-light hover:text-text"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect x="1" y="3.5" width="14" height="1.2" rx="0.6" fill="currentColor" />
          <rect x="1" y="7.4" width="14" height="1.2" rx="0.6" fill="currentColor" />
          <rect x="1" y="11.3" width="14" height="1.2" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-icon-success)]" aria-hidden="true" />
      {(threadStatus !== "idle" || isCompacting) && (
        <span
          className={`shrink-0 font-mono text-xs ${isCompacting || threadStatus === "busy" ? "text-text-success" : "text-danger"}`}
        >
          {isCompacting ? "Compacting..." : threadStatus === "busy" ? "Running..." : threadStatus}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-muted/90">{threadTitle || "NEW CONVERSATION"}</span>
      <button
        type="button"
        onClick={onOpenKnowledge}
        aria-label="Open knowledge"
        title="Knowledge"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-knowledge-backlog/35 bg-knowledge-backlog/12 text-sm text-knowledge-backlog/90 transition hover:border-knowledge-backlog/55 hover:bg-knowledge-backlog/18 hover:text-knowledge-backlog"
      >
        <span className="block leading-none">✦</span>
      </button>
      <button
        type="button"
        onClick={onOpenConfig}
        aria-label="Open config"
        title="Config"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border/100 bg-surface-light text-sm text-muted transition hover:border-border-strong/100 hover:bg-surface-strong hover:text-text"
      >
        <span className="block leading-none">⚙</span>
      </button>
    </div>
  );
}
