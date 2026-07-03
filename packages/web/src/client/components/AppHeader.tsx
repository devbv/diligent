// @summary Top navigation bar: sidebar toggle, thread status, title, and tool/knowledge buttons

import { LibraryBig, Menu, Settings } from "lucide-react";
import { iconButtonClasses } from "./ui-styles";

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
        aria-controls="app-sidebar"
        aria-expanded={sidebarOpen}
        title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        className={iconButtonClasses}
      >
        <Menu className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </button>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-icon-success" aria-hidden="true" />
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
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-knowledge-backlog/35 bg-knowledge-backlog/12 text-sm text-knowledge-backlog/90 transition hover:border-knowledge-backlog/55 hover:bg-knowledge-backlog/18 hover:text-knowledge-backlog"
      >
        <LibraryBig className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onOpenConfig}
        aria-label="Open config"
        title="Config"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/100 bg-surface-light text-sm text-muted transition hover:border-border-strong/100 hover:bg-surface-strong hover:text-text"
      >
        <Settings className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
