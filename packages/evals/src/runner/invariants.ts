// @summary Validates shared message, event, and tool-pair contracts before semantic evaluation

import type { AssistantMessage, Message, ToolCallBlock, ToolResultMessage } from "@diligent/core/message-contract";
import { MessageSchema } from "@diligent/protocol";
import type { EvalExecution, EvalFailure } from "../task";

export interface StructuralInvariantOptions {
  allowMultipleAgentLifecycles?: boolean;
}

export function checkStructuralInvariants(
  execution: EvalExecution<unknown>,
  options: StructuralInvariantOptions = {},
): EvalFailure[] {
  const failures: EvalFailure[] = [];
  validateMessages(execution.messages, failures);
  validateMessageTextMirrors(execution, failures);
  validateAgentLifecycle(execution, failures, options);
  validateTurnLifecycle(execution, failures);
  validateMessageLifecycle(execution, failures);
  validateToolEvents(execution, failures);
  validateToolMessages(execution.messages, failures);
  validateToolResultMirrors(execution, failures);
  validateFinalMessage(execution.messages, failures);
  return deduplicateFailures(failures);
}

function validateMessageTextMirrors(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const deltas = new Map<string, string[]>();
  for (const { event } of execution.events) {
    if (event.type !== "message_delta" || event.delta.type !== "text_delta") continue;
    const values = deltas.get(event.itemId) ?? [];
    values.push(event.delta.delta);
    deltas.set(event.itemId, values);
  }
  for (const { event } of execution.events) {
    if (event.type !== "message_end") continue;
    const expected = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (expected.length === 0) continue;
    const streamed = (deltas.get(event.itemId) ?? []).join("");
    if (streamed !== expected)
      failures.push(
        contractFailure(
          "streamed_text_mismatch",
          `${event.itemId} streamed text did not match its normalized final message.`,
        ),
      );
  }
}

function validateMessages(messages: Message[], failures: EvalFailure[]): void {
  for (let index = 0; index < messages.length; index++) {
    const parsed = MessageSchema.safeParse(messages[index]);
    if (!parsed.success) {
      failures.push(contractFailure("malformed_message", `Normalized message ${index} failed protocol validation.`));
    }
  }
}

function validateAgentLifecycle(
  execution: EvalExecution<unknown>,
  failures: EvalFailure[],
  options: StructuralInvariantOptions,
): void {
  const events = execution.events.map((snapshot) => snapshot.event);
  if (options.allowMultipleAgentLifecycles) {
    validateSequentialAgentLifecycles(events, failures);
    return;
  }
  const starts = events.reduce((count, event) => count + (event.type === "agent_start" ? 1 : 0), 0);
  const ends = events.reduce((count, event) => count + (event.type === "agent_end" ? 1 : 0), 0);
  if (starts !== 1)
    failures.push(contractFailure("agent_start_count", `Expected one agent_start, received ${starts}.`));
  if (ends !== 1) failures.push(contractFailure("agent_end_count", `Expected one agent_end, received ${ends}.`));
  if (events[0]?.type !== "agent_start") {
    failures.push(contractFailure("agent_start_order", "agent_start was not the first core lifecycle event."));
  }
  if (events.at(-1)?.type !== "agent_end") {
    failures.push(contractFailure("agent_end_order", "agent_end was not the final core lifecycle event."));
  }
  if (events.some((event) => event.type === "error" && event.fatal)) {
    failures.push(contractFailure("fatal_event", "A fatal core error event was emitted."));
  }
}

type SequentialAgentLifecycleEvent =
  | EvalExecution<unknown>["events"][number]["event"]
  | { type: "status_change"; status: "idle" | "busy" };

function validateSequentialAgentLifecycles(events: SequentialAgentLifecycleEvent[], failures: EvalFailure[]): void {
  let lifecycleOpen = false;
  let lifecycleCount = 0;
  let scope = createLifecycleScope();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "agent_start") {
      if (lifecycleOpen)
        failures.push(
          contractFailure("agent_lifecycle_overlap", "An agent lifecycle started before the prior one ended."),
        );
      lifecycleOpen = true;
      lifecycleCount += 1;
      scope = createLifecycleScope();
      continue;
    }
    if (event.type === "agent_end") {
      if (!lifecycleOpen)
        failures.push(contractFailure("agent_end_without_start", "An agent lifecycle ended without starting."));
      if (scope.turns.size > 0 || scope.messages.size > 0 || scope.tools.size > 0)
        failures.push(
          contractFailure("agent_lifecycle_unbalanced", "An agent lifecycle ended with unfinished nested events."),
        );
      lifecycleOpen = false;
      continue;
    }
    const isRerunBoundaryStatus =
      lifecycleCount > 0 &&
      event.type === "status_change" &&
      event.status === "busy" &&
      events[index + 1]?.type === "agent_start";
    if (!lifecycleOpen && !isRerunBoundaryStatus)
      failures.push(
        contractFailure("agent_event_outside_lifecycle", `${event.type} was emitted outside an agent lifecycle.`),
      );
    if (event.type === "turn_start") scope.turns.add(event.turnId);
    if (event.type === "turn_end" && !scope.turns.delete(event.turnId))
      failures.push(
        contractFailure("agent_lifecycle_unbalanced", `${event.turnId} ended in a different agent lifecycle.`),
      );
    if (event.type === "message_start") scope.messages.add(event.itemId);
    if (event.type === "message_end" && !scope.messages.delete(event.itemId))
      failures.push(
        contractFailure("agent_lifecycle_unbalanced", `${event.itemId} ended in a different agent lifecycle.`),
      );
    if (event.type === "tool_start") scope.tools.add(event.toolCallId);
    if (event.type === "tool_end" && !scope.tools.delete(event.toolCallId))
      failures.push(
        contractFailure("agent_lifecycle_unbalanced", `${event.toolCallId} ended in a different agent lifecycle.`),
      );
  }
  if (lifecycleCount === 0)
    failures.push(contractFailure("agent_start_count", "Expected at least one agent_start, received 0."));
  if (lifecycleOpen)
    failures.push(contractFailure("agent_without_end", "The final agent lifecycle did not emit agent_end."));
  if (events.some((event) => event.type === "error" && event.fatal))
    failures.push(contractFailure("fatal_event", "A fatal core error event was emitted."));
}

function createLifecycleScope(): { turns: Set<string>; messages: Set<string>; tools: Set<string> } {
  return { turns: new Set(), messages: new Set(), tools: new Set() };
}

function validateTurnLifecycle(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const open = new Set<string>();
  for (const { event } of execution.events) {
    if (event.type === "turn_start") {
      if (open.has(event.turnId)) failures.push(contractFailure("duplicate_turn_start", `Duplicate ${event.turnId}.`));
      open.add(event.turnId);
    }
    if (event.type === "turn_end") {
      if (!open.delete(event.turnId))
        failures.push(contractFailure("turn_end_without_start", `${event.turnId} ended without starting.`));
    }
  }
  for (const turnId of open) failures.push(contractFailure("turn_without_end", `${turnId} did not emit turn_end.`));
}

function validateMessageLifecycle(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const open = new Set<string>();
  for (const { event } of execution.events) {
    if (event.type === "message_start") {
      if (open.has(event.itemId))
        failures.push(contractFailure("duplicate_message_start", `Duplicate ${event.itemId}.`));
      open.add(event.itemId);
    }
    if (event.type === "message_delta" && !open.has(event.itemId)) {
      failures.push(
        contractFailure("message_delta_without_start", `${event.itemId} emitted a delta before message_start.`),
      );
    }
    if (event.type === "message_end" && !open.delete(event.itemId)) {
      failures.push(contractFailure("message_end_without_start", `${event.itemId} ended without message_start.`));
    }
  }
  for (const itemId of open)
    failures.push(contractFailure("message_without_end", `${itemId} did not emit message_end.`));
}

function validateToolEvents(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const open = new Map<string, string>();
  for (const { event } of execution.events) {
    if (event.type === "tool_start") {
      if (open.has(event.toolCallId)) {
        failures.push(contractFailure("duplicate_tool_start", `Duplicate tool start ${event.toolCallId}.`));
      }
      open.set(event.toolCallId, event.toolName);
    }
    if (event.type === "tool_end") {
      const toolName = open.get(event.toolCallId);
      if (!toolName) {
        failures.push(contractFailure("tool_end_without_start", `${event.toolCallId} ended without tool_start.`));
      } else if (toolName !== event.toolName) {
        failures.push(contractFailure("tool_event_name_mismatch", `${event.toolCallId} changed tool names.`));
      }
      open.delete(event.toolCallId);
    }
  }
  for (const toolCallId of open.keys()) {
    failures.push(contractFailure("tool_without_end", `${toolCallId} did not emit tool_end.`));
  }
}

function validateToolMessages(messages: Message[], failures: EvalFailure[]): void {
  const pending = new Map<string, ToolCallBlock>();
  for (const message of messages) {
    if (isAssistantMessage(message)) {
      for (const block of message.content) {
        if (block.type !== "tool_call") continue;
        if (pending.has(block.id))
          failures.push(contractFailure("duplicate_tool_call", `Duplicate tool call ${block.id}.`));
        pending.set(block.id, block);
      }
      continue;
    }
    if (!isToolResultMessage(message)) continue;
    const call = pending.get(message.toolCallId);
    if (!call) {
      failures.push(
        contractFailure("orphaned_tool_result", `Tool result ${message.toolCallId} has no preceding call.`),
      );
      continue;
    }
    if (call.name !== message.toolName) {
      failures.push(contractFailure("tool_result_name_mismatch", `${message.toolCallId} changed tool names.`));
    }
    pending.delete(message.toolCallId);
  }
  for (const toolCallId of pending.keys()) {
    failures.push(contractFailure("orphaned_tool_call", `Tool call ${toolCallId} has no result.`));
  }
}

function validateToolResultMirrors(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const ends = new Map<string, Extract<EvalExecution<unknown>["events"][number]["event"], { type: "tool_end" }>>();
  for (const { event } of execution.events) {
    if (event.type === "tool_end") ends.set(event.toolCallId, event);
  }
  for (const message of execution.messages) {
    if (!isToolResultMessage(message)) continue;
    const end = ends.get(message.toolCallId);
    if (!end) continue;
    if (end.isError !== message.isError)
      failures.push(
        contractFailure(
          "tool_result_error_mismatch",
          `${message.toolCallId} changed its normalized error flag between event and message surfaces.`,
        ),
      );
    if (JSON.stringify(end.outputImages) !== JSON.stringify(message.outputImages))
      failures.push(
        contractFailure(
          "tool_result_image_mismatch",
          `${message.toolCallId} changed its image evidence between event and message surfaces.`,
        ),
      );
  }
}

function validateFinalMessage(messages: Message[], failures: EvalFailure[]): void {
  const finalMessage = messages.at(-1);
  if (!isAssistantMessage(finalMessage) || !Array.isArray(finalMessage.content)) {
    failures.push(
      contractFailure("missing_final_assistant", "Completed execution did not end with an assistant message."),
    );
    return;
  }
  if (finalMessage.stopReason !== "end_turn") {
    failures.push(contractFailure("abnormal_stop_reason", `Final stop reason was ${finalMessage.stopReason}.`));
  }
  if (finalMessage.content.some((block) => block.type === "tool_call")) {
    failures.push(contractFailure("pending_final_tool_call", "Final assistant message still contains a tool call."));
  }
}

function isAssistantMessage(message: Message | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

function isToolResultMessage(message: Message): message is ToolResultMessage {
  return message.role === "tool_result";
}

function contractFailure(code: string, message: string): EvalFailure {
  return { dimension: "runtime_policy", category: "core_contract", code: `core_contract.${code}`, message };
}

function deduplicateFailures(failures: EvalFailure[]): EvalFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    if (seen.has(failure.code)) return false;
    seen.add(failure.code);
    return true;
  });
}
