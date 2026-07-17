// @summary Validates shared message, event, and tool-pair contracts before semantic evaluation

import type { AssistantMessage, Message, ToolCallBlock, ToolResultMessage } from "@diligent/core/message-contract";
import { MessageSchema } from "@diligent/protocol";
import type { EvalExecution, EvalFailure } from "../task";

export function checkStructuralInvariants(execution: EvalExecution<unknown>): EvalFailure[] {
  const failures: EvalFailure[] = [];
  validateMessages(execution.messages, failures);
  validateAgentLifecycle(execution, failures);
  validateTurnLifecycle(execution, failures);
  validateMessageLifecycle(execution, failures);
  validateToolEvents(execution, failures);
  validateToolMessages(execution.messages, failures);
  validateFinalMessage(execution.messages, failures);
  return deduplicateFailures(failures);
}

function validateMessages(messages: Message[], failures: EvalFailure[]): void {
  for (let index = 0; index < messages.length; index++) {
    const parsed = MessageSchema.safeParse(messages[index]);
    if (!parsed.success) {
      failures.push(contractFailure("malformed_message", `Normalized message ${index} failed protocol validation.`));
    }
  }
}

function validateAgentLifecycle(execution: EvalExecution<unknown>, failures: EvalFailure[]): void {
  const events = execution.events.map((snapshot) => snapshot.event);
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
  return { category: "core_contract", code: `core_contract.${code}`, message };
}

function deduplicateFailures(failures: EvalFailure[]): EvalFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    if (seen.has(failure.code)) return false;
    seen.add(failure.code);
    return true;
  });
}
