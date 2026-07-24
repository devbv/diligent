// @summary Persistent plan progress panel displayed between MessageList and InputDock
import { memo, useState } from "react";
import type { PlanState } from "../lib/thread-store";

function PlanPanelImpl({ planState }: { planState: PlanState }) {
  const [collapsed, setCollapsed] = useState(false);
  const doneCount = planState.steps.filter((s) => s.status === "done").length;
  const activeSteps = planState.steps.filter((s) => s.status !== "cancelled");
  const totalCount = activeSteps.length;
  const completedLabel = `${totalCount} tasks · ${doneCount} done`;

  function getMarker(status: PlanState["steps"][number]["status"]) {
    switch (status) {
      case "done":
        return "◉";
      case "cancelled":
        return "⊘";
      case "in_progress":
        return "◎";
      default:
        return "○";
    }
  }

  return (
    <div className="shrink-0 border-t border-border/10 bg-surface-dark px-7 pt-3 pb-0">
      <div className="mx-auto w-full max-w-plan overflow-hidden rounded-lg border border-border/100 bg-surface-default">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex w-full items-center justify-between gap-2 border-b border-border/20 px-4 py-2 text-left transition hover:bg-fill-ghost-hover"
        >
          <div className="min-w-0 flex items-center gap-2 overflow-hidden pl-2">
            <span className="shrink-0 font-mono text-sm text-text-secondary">☷</span>
            <div className="truncate text-sm font-medium text-text-secondary">
              {planState.title.trim() && planState.title !== "Plan"
                ? `${planState.title} · ${completedLabel}`
                : completedLabel}
            </div>
          </div>
          <span className="shrink-0 rounded-md p-1 text-text-tertiary transition hover:text-text-secondary">
            {collapsed ? "▾" : "▴"}
          </span>
        </button>

        {!collapsed ? (
          <ul className="max-h-48 overflow-y-auto px-4 pt-1.5 pb-2 text-sm leading-relaxed">
            {planState.steps.map((step) => (
              <li
                key={step.text}
                className={`flex items-start gap-2 rounded-lg px-2 py-0.5 ${
                  step.status === "done"
                    ? "text-text-tertiary"
                    : step.status === "cancelled"
                      ? "text-text-tertiary"
                      : step.status === "in_progress"
                        ? "text-text"
                        : "text-text"
                }`}
              >
                <span className="shrink-0 pt-0.5 font-mono text-sm text-text-secondary">{getMarker(step.status)}</span>
                <span className={step.status === "done" || step.status === "cancelled" ? "line-through" : undefined}>
                  {step.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export const PlanPanel = memo(PlanPanelImpl);
