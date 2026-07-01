// @summary Compact tool call row with one-line summary and click-to-expand detail panel

import { useState } from "react";
import type { RenderItem } from "../lib/thread-store";
import { normalizeToolName } from "../lib/thread-utils";
import { getToolActivityLabel, getToolInfo, summarizeInput, summarizeOutput } from "../lib/tool-info";
import { ContentText } from "./ContentText";
import { ToolActivityRow } from "./ToolActivityRow";

interface ToolCallRowProps {
  item: Extract<RenderItem, { kind: "tool" }>;
}

export function ToolCallRow({ item }: ToolCallRowProps) {
  const [open, setOpen] = useState(false);
  const renderPayload = item.render;
  const toolInfo = getToolInfo(item.toolName);
  const activityTitle = getToolActivityLabel(item.toolName, item.status, item.isError);
  const normalizedToolName = normalizeToolName(item.toolName);
  const isUserInput = normalizedToolName === "request_user_input";
  const inputSummary = summarizeInput(renderPayload);
  const outputSummary = renderPayload && !isUserInput && item.status === "done" ? summarizeOutput(renderPayload) : "";
  const showOutputSummary = Boolean(outputSummary) && outputSummary !== inputSummary;
  const isStreaming = item.status === "streaming";

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-tool-row">
        <ToolActivityRow
          title={activityTitle}
          detail={inputSummary}
          outputSummary={showOutputSummary ? outputSummary : undefined}
          icon={toolInfo.icon}
          category={toolInfo.category}
          status={item.status}
          isError={item.isError}
          isBusy={isStreaming}
          durationLabel={null}
          expanded={open}
          expandable={!isStreaming && !item.isError}
          onToggle={() => setOpen((v) => !v)}
        />

        {open ? (
          <div className="mt-2 space-y-2">
            {item.inputText ? <ContentText text={item.inputText} label="Input" /> : null}
            {item.outputText ? <ContentText text={item.outputText} label="Output" isError={item.isError} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
