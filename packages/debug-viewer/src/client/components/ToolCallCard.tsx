import { useState } from "react";
import type { ToolCallBlock, ToolCallPair } from "../lib/types.js";
import { JsonViewer } from "./JsonViewer.js";

interface ToolCallCardProps {
  toolCall: ToolCallBlock;
  pair: ToolCallPair | undefined;
  onSelect: (entry: unknown) => void;
}

function formatDuration(startTime: number, endTime: number): string {
  const ms = endTime - startTime;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

const TOOL_ICONS: Record<string, string> = {
  read: "R",
  write: "W",
  edit: "E",
  bash: "$",
  glob: "G",
  grep: "?",
};

export function ToolCallCard({ toolCall, pair, onSelect }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isError = pair?.result?.isError ?? false;
  const icon = TOOL_ICONS[toolCall.name] ?? "T";
  const duration =
    pair?.startTime != null && pair?.endTime != null
      ? formatDuration(pair.startTime, pair.endTime)
      : undefined;

  const inputPreview = Object.entries(toolCall.input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50)}`)
    .join(", ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: wrapper div delegates to inner button
    <div
      className={`tool-call-card ${isError ? "tool-error" : ""} ${expanded ? "expanded" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(pair ?? toolCall);
      }}
    >
      <button type="button" className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className={`tool-icon ${isError ? "error" : ""}`}>{icon}</span>
        <span className="tool-name">{toolCall.name}</span>
        <span className="tool-input-preview">{inputPreview}</span>
        {isError && <span className="tool-error-badge">ERR</span>}
        {duration && <span className="tool-duration">{duration}</span>}
        <span className="tool-expand">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>

      {expanded && (
        <div className="tool-call-detail">
          <div className="tool-section">
            <div className="tool-section-label">Input</div>
            <JsonViewer data={toolCall.input} collapsed={3} />
          </div>
          {pair?.result && (
            <div className="tool-section">
              <div className="tool-section-label">
                Output {isError && <span className="tool-output-error-badge">Error</span>}
              </div>
              <pre className={`tool-output ${isError ? "error" : ""}`}>{pair.result.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
