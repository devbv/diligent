// @summary Pending steering panel rendering queued messages as stacked single lines above InputDock

import type { PendingSteer } from "@diligent/protocol";
import { memo, useState } from "react";

interface SteeringQueuePanelProps {
  pendingSteers: PendingSteer[];
  onCancelSteer: (steerId: string) => void;
  onUpdateSteer: (steerId: string, text: string) => void;
}

function SteeringQueuePanelImpl({ pendingSteers, onCancelSteer, onUpdateSteer }: SteeringQueuePanelProps) {
  const [editing, setEditing] = useState<{ steerId: string; text: string } | null>(null);
  if (pendingSteers.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border/10 pl-6 pr-4 py-2">
      <div className="space-y-1 font-mono text-xs text-accent/90">
        {pendingSteers.map((steer, i) => {
          const text = steer.content;
          const currentEdit = editing?.steerId === steer.id ? editing : null;
          return (
            <div key={steer.id} className="flex min-w-0 items-center gap-2">
              {currentEdit ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = currentEdit.text.trim();
                    if (!next) return;
                    onUpdateSteer(steer.id, next);
                    setEditing(null);
                  }}
                >
                  <span className="shrink-0">⚑</span>
                  <input
                    value={currentEdit.text}
                    onChange={(event) => setEditing({ steerId: steer.id, text: event.target.value })}
                    className="min-w-0 flex-1 rounded border border-border/50 bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    className="shrink-0 rounded border border-border/40 px-2 py-1 text-[11px] text-text transition hover:border-border-strong"
                  >
                    Save
                  </button>
                </form>
              ) : (
                <div className="truncate">⚑ {text}</div>
              )}
              <button
                type="button"
                aria-label={`Edit queued steer ${i + 1}`}
                title="Edit queued steer"
                onClick={() => setEditing(currentEdit ? null : { steerId: steer.id, text })}
                className="ml-auto inline-flex h-5 w-8 shrink-0 items-center justify-center rounded border border-border/40 text-[11px] text-muted transition hover:border-border-strong hover:text-text"
              >
                edit
              </button>
              <button
                type="button"
                aria-label={`Cancel queued steer ${i + 1}`}
                title="Cancel queued steer"
                onClick={() => {
                  if (editing?.steerId === steer.id) setEditing(null);
                  onCancelSteer(steer.id);
                }}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/40 text-[11px] text-muted transition hover:border-border-strong hover:text-text"
              >
                x
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const SteeringQueuePanel = memo(SteeringQueuePanelImpl);
