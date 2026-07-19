// @summary Collects bounded deterministic snapshots at the final runtime provider-call boundary

import type { Model, StreamContext, StreamOptions } from "@diligent/core/provider-contract";
import type {
  RuntimeBoundedEvidenceCollection,
  RuntimeProviderCallEvidence,
  RuntimeProviderEvidenceBounds,
} from "../runtime-task";

export const RUNTIME_PROVIDER_EVIDENCE_LIMITS = {
  maxSourceItems: 64,
  maxNestedItems: 64,
  maxObjectProperties: 64,
  maxStringChars: 8_192,
  maxDepth: 12,
} as const;

export function captureRuntimeProviderCall(input: {
  sequence: number;
  model: Model;
  context: StreamContext;
  options: StreamOptions;
  normalize: (value: unknown) => unknown;
}): RuntimeProviderCallEvidence {
  const bounds: RuntimeProviderEvidenceBounds = {
    ...RUNTIME_PROVIDER_EVIDENCE_LIMITS,
    truncatedStrings: 0,
    omittedNestedItems: 0,
    omittedObjectProperties: 0,
  };
  const sanitize = (value: unknown) => input.normalize(boundEvidence(value, bounds, 0));
  const systemPrompt = boundedSource(input.context.systemPrompt, bounds, sanitize);
  const messages = boundedSource(input.context.messages, bounds, sanitize);
  const tools = boundedSource(input.context.tools, bounds, sanitize);
  const sessionId = boundedScalar(input.options.sessionId, bounds);

  return {
    sequence: input.sequence,
    model: { provider: input.model.provider, modelId: boundedScalar(input.model.modelId, bounds) },
    ...(sessionId !== undefined ? { sessionId } : {}),
    systemPrompt: systemPrompt as RuntimeProviderCallEvidence["systemPrompt"],
    messages,
    tools: tools as RuntimeProviderCallEvidence["tools"],
    ...(input.context.compactionSummary !== undefined
      ? { compactionSummary: sanitize(input.context.compactionSummary) }
      : {}),
    streamOptions: {
      ...(input.options.maxTokens !== undefined ? { maxTokens: input.options.maxTokens } : {}),
      ...(input.options.temperature !== undefined ? { temperature: input.options.temperature } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(input.options.effort !== undefined ? { effort: input.options.effort } : {}),
    },
    bounds,
  };
}

function boundedSource<T>(
  values: readonly T[],
  bounds: RuntimeProviderEvidenceBounds,
  sanitize: (value: unknown) => unknown,
): RuntimeBoundedEvidenceCollection<unknown> {
  const included = values.slice(0, bounds.maxSourceItems);
  return {
    totalCount: values.length,
    includedCount: included.length,
    omittedCount: values.length - included.length,
    items: included.map(sanitize),
  };
}

function boundEvidence(value: unknown, bounds: RuntimeProviderEvidenceBounds, depth: number): unknown {
  if (typeof value === "string") return boundedScalar(value, bounds);
  if (value === null || typeof value !== "object") return value;
  if (depth >= bounds.maxDepth) {
    bounds.omittedObjectProperties += 1;
    return "[depth omitted]";
  }
  if (Array.isArray(value)) {
    const included = value.slice(0, bounds.maxNestedItems);
    bounds.omittedNestedItems += value.length - included.length;
    return included.map((item) => boundEvidence(item, bounds, depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const included = entries.slice(0, bounds.maxObjectProperties);
  bounds.omittedObjectProperties += entries.length - included.length;
  return Object.fromEntries(
    included.map(([key, item]) => [
      key,
      key === "data" && isBase64Container(value) ? "[base64 omitted]" : boundEvidence(item, bounds, depth + 1),
    ]),
  );
}

function boundedScalar(value: string, bounds: RuntimeProviderEvidenceBounds): string;
function boundedScalar(value: string | undefined, bounds: RuntimeProviderEvidenceBounds): string | undefined;
function boundedScalar(value: string | undefined, bounds: RuntimeProviderEvidenceBounds): string | undefined {
  if (value === undefined || value.length <= bounds.maxStringChars) return value;
  bounds.truncatedStrings += 1;
  return `${value.slice(0, bounds.maxStringChars)}[truncated ${value.length - bounds.maxStringChars} chars]`;
}

function isBase64Container(value: object): boolean {
  return (value as { type?: unknown }).type === "base64";
}
