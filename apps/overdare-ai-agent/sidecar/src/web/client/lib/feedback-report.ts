// @summary Derives UI-only message report context and user-facing status copy

import { RpcRequestError } from "./rpc-client";
import type { RenderItem } from "./thread-store";

type ReportableRenderItem = Extract<RenderItem, { kind: "assistant" | "user" }>;

export interface FeedbackReportTarget {
  kind: "request" | "response";
  messageId: string;
  preview: string;
}

function messageText(item: ReportableRenderItem): string {
  if (item.kind === "user") return item.text;
  if (item.text.trim()) return item.text;
  return item.contentBlocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function messagePreview(item: ReportableRenderItem): string {
  const lines = messageText(item)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((line) => line.slice(0, 240));
  if (lines.length > 0) return lines.join("\n");
  if (item.kind === "user" && (item.images.length > 0 || (item.contextItems?.length ?? 0) > 0)) {
    return "Request with attachment";
  }
  if (item.kind === "assistant" && item.contentBlocks.some((block) => block.type !== "thinking")) {
    return "Structured response";
  }
  return "";
}

export function createFeedbackReportTarget(item: ReportableRenderItem): FeedbackReportTarget {
  if (!item.messageId) {
    throw new Error("Persistent message ID is unavailable");
  }
  return {
    kind: item.kind === "user" ? "request" : "response",
    messageId: item.messageId,
    preview: messagePreview(item),
  };
}

export function formatFeedbackReceiptToast(): string {
  return "Report sent. We'll take a look.";
}

export function formatFeedbackSubmitError(error: unknown): string {
  const data =
    error instanceof RpcRequestError && typeof error.data === "object" && error.data !== null
      ? (error.data as { httpStatus?: unknown })
      : null;
  if (data?.httpStatus === 429) {
    return "Too many reports. Please try again later.";
  }
  return "Couldn't send your report. Please try again in a moment.";
}
