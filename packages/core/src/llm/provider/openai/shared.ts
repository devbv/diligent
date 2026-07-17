// @summary Shared OpenAI utilities: transient-error classification and compaction payload/summary extraction

/**
 * Whether an OpenAI error message indicates a transient failure worth retrying.
 * Shared by all OpenAI-shaped paths (SDK exceptions, raw ChatGPT fetch, and
 * mid-stream `response.failed` SSE events) so the pattern list can't diverge.
 */
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

function pushText(chunks: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  chunks.push(trimmed);
}

function pushReasoningSummary(chunks: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const rawPart of value) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    pushText(chunks, part.text);
  }
}

function extractCompactionTranscriptFromOutput(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;

  const parts: string[] = [];
  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type !== "message") continue;

    const role = typeof item.role === "string" ? item.role : undefined;
    if (!Array.isArray(item.content)) continue;

    const textChunks: string[] = [];
    for (const rawPart of item.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      const type = typeof part.type === "string" ? part.type : undefined;
      if ((type === "input_text" || type === "output_text" || type === "text") && typeof part.text === "string") {
        const trimmed = part.text.trim();
        if (trimmed.length > 0) textChunks.push(trimmed);
      }
    }

    if (textChunks.length === 0) continue;
    const body = textChunks.join("\n");
    if (role === "assistant") {
      parts.push(`<assistant>\n${body}\n</assistant>`);
    } else {
      parts.push(`<user>\n${body}\n</user>`);
    }
  }

  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function extractCompactionSummaryFromOutput(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;

  const chunks: string[] = [];
  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;

    pushText(chunks, item.summary);
    pushReasoningSummary(chunks, item.summary);
    pushText(chunks, item.compaction_summary);
    pushText(chunks, item.compacted_summary);
    if (item.type !== "message" || !Array.isArray(item.content)) {
      pushText(chunks, item.text);
    }

    if (item.type === "message") {
      if (Array.isArray(item.content)) {
        for (const rawPart of item.content) {
          if (typeof rawPart === "string") {
            continue;
          }
          if (!rawPart || typeof rawPart !== "object") continue;
          const part = rawPart as Record<string, unknown>;
          pushText(chunks, part.summary);
          pushReasoningSummary(chunks, part.summary);
          pushText(chunks, part.compaction_summary);
          pushText(chunks, part.compacted_summary);
          if (part.type === "output_text" || part.type === "text") {
            pushText(chunks, part.text);
          }
        }
      } else {
        if (typeof item.role !== "string" || item.role !== "user") {
          pushText(chunks, item.content);
        }
      }
      continue;
    }

    if (item.type === "output_text" || item.type === "text") {
      pushText(chunks, item.text);
    }
  }

  if (chunks.length === 0) return undefined;
  return chunks.join("\n");
}

function summarizeOutputShape(output: unknown): string {
  if (!Array.isArray(output)) return "none";
  const shapes = output.slice(0, 8).map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return "unknown";
    const item = rawItem as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "unknown";
    if (!Array.isArray(item.content)) return itemType;
    const contentTypes = item.content
      .slice(0, 3)
      .map((rawPart) => {
        if (!rawPart || typeof rawPart !== "object") return typeof rawPart;
        const part = rawPart as Record<string, unknown>;
        return typeof part.type === "string" ? part.type : "obj";
      })
      .join("+");
    return `${itemType}[${contentTypes || "empty"}]`;
  });
  return shapes.join(";") || "empty";
}

function countStructuredCompactionItems(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  return output.filter((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return false;
    const item = rawItem as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    return itemType === "compaction" || itemType === "compaction_summary";
  }).length;
}

export function describeCompactionPayload(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  const topKeys = keys.length > 0 ? keys.slice(0, 8).join(",") : "none";
  const outputLen = Array.isArray(payload.output) ? payload.output.length : 0;
  const outputShape = summarizeOutputShape(payload.output);
  const structuredCompactionItems = countStructuredCompactionItems(payload.output);
  return `payload_keys=${topKeys} output_items=${outputLen} output_shape=${outputShape} structured_compaction_items=${structuredCompactionItems}`;
}

export function extractCompactionSummary(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.compaction_summary === "string") return payload.compaction_summary;
  if (typeof payload.compacted_summary === "string") return payload.compacted_summary;
  if (extractCompactionSummaryItem(payload)) return undefined;
  const fromOutput = extractCompactionSummaryFromOutput(payload.output);
  if (fromOutput) return fromOutput;
  const transcript = extractCompactionTranscriptFromOutput(payload.output);
  if (transcript) return transcript;
  return undefined;
}

export function extractCompactionSummaryItem(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.output)) return undefined;
  for (const rawItem of payload.output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (
      (itemType === "compaction" || itemType === "compaction_summary") &&
      typeof item.encrypted_content === "string"
    ) {
      return { type: "compaction", encrypted_content: item.encrypted_content };
    }
  }
  return undefined;
}
