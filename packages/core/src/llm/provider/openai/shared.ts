// @summary Shared OpenAI transient-error classification and structured compaction decoding

/** Shared by SDK exceptions, ChatGPT fetch, and mid-stream failure events. */
export function isTransientOpenAIErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("can retry your request") ||
    normalized.includes("service unavailable") ||
    normalized.includes("server had an error") ||
    normalized.includes("internal server error")
  );
}

function summarizeOutputShape(output: unknown): string {
  if (!Array.isArray(output)) return "none";
  const shapes = output.slice(0, 8).map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return "unknown";
    const item = rawItem as Record<string, unknown>;
    return typeof item.type === "string" ? item.type : "unknown";
  });
  return shapes.join(";") || "empty";
}

function countStructuredCompactionItems(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  return output.filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "compaction" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string",
  ).length;
}

export function describeCompactionPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  const topKeys = keys.length > 0 ? keys.slice(0, 8).join(",") : "none";
  const outputLen = Array.isArray(payload.output) ? payload.output.length : 0;
  return `payload_keys=${topKeys} output_items=${outputLen} output_shape=${summarizeOutputShape(payload.output)} structured_compaction_items=${countStructuredCompactionItems(payload.output)}`;
}

export function extractCompactionSummaryItem(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.output)) return undefined;
  for (const rawItem of payload.output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "compaction" && typeof item.encrypted_content === "string") {
      return { type: "compaction", encrypted_content: item.encrypted_content };
    }
  }
  return undefined;
}
