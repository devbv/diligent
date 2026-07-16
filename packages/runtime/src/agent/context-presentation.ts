// @summary Runtime-owned presentation metadata for trusted agent-loop context injections

import type { AgentContextInjection } from "@diligent/core/agent";
import { type ContextPresentation, ContextPresentationSchema } from "@diligent/protocol";

const PRESENTATION_KEY = "presentation";

export function createPresentableContextInjection(options: {
  source: string;
  content: AgentContextInjection["content"];
  presentation: ContextPresentation;
}): AgentContextInjection {
  return {
    source: options.source,
    content: options.content,
    metadata: { [PRESENTATION_KEY]: options.presentation },
  };
}

export function readContextPresentation(
  metadata: Record<string, unknown> | undefined,
): ContextPresentation | undefined {
  const parsed = ContextPresentationSchema.safeParse(metadata?.[PRESENTATION_KEY]);
  return parsed.success ? parsed.data : undefined;
}

export type { ContextPresentation };
