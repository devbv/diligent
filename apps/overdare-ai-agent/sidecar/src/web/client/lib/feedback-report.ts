// @summary Derives UI-only response report context and receipt copy

import type { RenderItem } from "./thread-store";

type AssistantRenderItem = Extract<RenderItem, { kind: "assistant" }>;

export interface FeedbackReportTarget {
  messageId: string;
  preview: string;
  occurredAt: string;
  agentModel?: string;
}

function responseText(item: AssistantRenderItem): string {
  if (item.text.trim()) return item.text;
  return item.contentBlocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function responsePreview(item: AssistantRenderItem): string {
  const lines = responseText(item)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((line) => line.slice(0, 240));
  return lines.join("\n");
}

export function createFeedbackReportTarget(item: AssistantRenderItem): FeedbackReportTarget {
  return {
    messageId: item.id,
    preview: responsePreview(item),
    occurredAt: new Date(item.timestamp).toISOString(),
    ...(item.model ? { agentModel: `${item.model.provider}/${item.model.modelId}` } : {}),
  };
}

export function formatFeedbackReceiptToast(reportId: string): string {
  return `Report submitted (#${reportId})`;
}
