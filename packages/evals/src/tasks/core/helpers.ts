// @summary Shared deterministic fixture and trace helpers for core eval tasks

import type { AssistantMessage } from "@diligent/core/message-contract";
import { deriveFixtureValue } from "../../runner/seed";
import type { EvalExecution } from "../../task";

export interface EvalToolTrace {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export function fixtureToken(seed: string, label: string, prefix: string): string {
  return `${prefix}_${deriveFixtureValue(seed, label)}`;
}

export function getFinalAssistant<TWorld>(execution: EvalExecution<TWorld>): AssistantMessage | undefined {
  const message = execution.messages.at(-1);
  return message?.role === "assistant" ? message : undefined;
}

export function getFinalText<TWorld>(execution: EvalExecution<TWorld>): string {
  return (
    getFinalAssistant(execution)
      ?.content.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim() ?? ""
  );
}

export function getTextDeltas<TWorld>(execution: EvalExecution<TWorld>): string {
  return execution.events
    .flatMap(({ event }) =>
      event.type === "message_delta" && event.delta.type === "text_delta" ? [event.delta.delta] : [],
    )
    .join("")
    .trim();
}

export function getToolTrace<TWorld>(execution: EvalExecution<TWorld>): EvalToolTrace[] {
  return execution.events.flatMap(({ event }) =>
    event.type === "tool_start" ? [{ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }] : [],
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
