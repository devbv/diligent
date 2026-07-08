// @summary Tests for the soft plan reminder (recitation) integrated into runAgentLoop
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import { EventStream } from "../../src/event-stream";
import type { NativeCompactFn } from "../../src/llm/provider/native-compaction";
import type { Model, ProviderEvent, ProviderResult, StreamContext, StreamFunction } from "../../src/llm/types";
import type { Tool } from "../../src/tool/types";
import type { AssistantMessage, Message } from "../../src/types";

const TEST_MODEL: Model = { id: "test-model", provider: "test", contextWindow: 200_000, maxOutputTokens: 4096 };

function makeAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "end_turn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL.id,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockStreamFunction(responses: AssistantMessage[]): StreamFunction & { contexts: StreamContext[] } {
  let callIndex = 0;
  const contexts: StreamContext[] = [];
  const fn: StreamFunction = (_model, context, _streamOptions) => {
    // Snapshot messages: the loop passes its live `conversation` array by reference, so
    // without copying, every captured context would reflect the final state, not the
    // per-turn state we assert on.
    contexts.push({ ...context, messages: [...context.messages] });
    const msg = responses[callIndex++];
    const stream = new EventStream<ProviderEvent, ProviderResult>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return { message: event.message };
        throw (event as { type: "error"; error: Error }).error;
      },
    );
    setTimeout(() => {
      stream.push({ type: "start" });
      for (const block of msg.content) {
        if (block.type === "text") {
          stream.push({ type: "text_delta", delta: block.text });
          stream.push({ type: "text_end", text: block.text });
        } else if (block.type === "tool_call") {
          stream.push({ type: "tool_call_start", id: block.id, name: block.name });
          stream.push({ type: "tool_call_end", id: block.id, name: block.name, input: block.input });
        }
      }
      stream.push({ type: "done", stopReason: msg.stopReason, message: msg });
    }, 0);
    return stream;
  };
  return Object.assign(fn, { contexts });
}

type Step = { text: string; status: "pending" | "in_progress" | "done" | "cancelled" };

function planTool(): Tool {
  return {
    name: "plan",
    description: "plan",
    supportParallel: true,
    parameters: z.object({
      steps: z.array(z.object({ text: z.string(), status: z.string() })),
      title: z.string().optional(),
    }),
    async execute(args: { steps: Step[]; title?: string }) {
      return { output: JSON.stringify({ title: args.title ?? "Plan", steps: args.steps, hint: "..." }) };
    },
  };
}

function noopTool(output = "ok"): Tool {
  return {
    name: "noop",
    description: "noop",
    parameters: z.object({}),
    async execute() {
      return { output };
    },
  };
}

let planCallSeq = 0;
let noopCallSeq = 0;
const planCall = (steps: Step[]) =>
  makeAssistant([{ type: "tool_call", id: `p${++planCallSeq}`, name: "plan", input: { steps } }], "tool_use");
const noopCall = () =>
  makeAssistant([{ type: "tool_call", id: `n${++noopCallSeq}`, name: "noop", input: {} }], "tool_use");
const finalText = () => makeAssistant([{ type: "text", text: "완료했습니다" }]);

const hasReminder = (ctx: StreamContext): boolean =>
  ctx.messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("do not end your turn until each"),
  );
const reminderMentions = (ctx: StreamContext, text: string): boolean =>
  ctx.messages.some(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.includes("do not end your turn until each") &&
      m.content.includes(text),
  );
// The injected reminder is a real message that persists in the conversation, so counting
// them (rather than checking presence) tells us how many times it actually fired.
const countReminders = (ctx: StreamContext): number =>
  ctx.messages.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("do not end your turn until each"),
  ).length;

function makeAgent(streamFn: StreamFunction, planReminderIntervalTurns?: number): Agent {
  return new Agent(TEST_MODEL, [{ label: "sys", content: "sys" }], [planTool(), noopTool()], {
    effort: "medium",
    llmMsgStreamFn: streamFn,
    planReminderIntervalTurns,
  });
}

const userMsg = (): Message => ({ role: "user", content: "do it", timestamp: Date.now() });

describe("plan reminder (recitation)", () => {
  test("fires after N turns without a plan update, listing remaining steps", async () => {
    const streamFn = createMockStreamFunction([
      planCall([{ text: "step A", status: "pending" }]),
      noopCall(),
      noopCall(),
      finalText(),
    ]);
    await makeAgent(streamFn, 2).prompt(userMsg());

    // turn4 (contexts[3]) is where the reminder should first appear.
    expect(streamFn.contexts.length).toBe(4);
    expect(reminderMentions(streamFn.contexts[3], "step A")).toBe(true);
    // Not before the cadence elapsed.
    expect(hasReminder(streamFn.contexts[1])).toBe(false);
    expect(hasReminder(streamFn.contexts[2])).toBe(false);
  });

  test("does not fire when all steps are resolved", async () => {
    const streamFn = createMockStreamFunction([
      planCall([
        { text: "A", status: "done" },
        { text: "B", status: "cancelled" },
      ]),
      noopCall(),
      noopCall(),
      noopCall(),
      finalText(),
    ]);
    await makeAgent(streamFn, 1).prompt(userMsg());
    expect(streamFn.contexts.some(hasReminder)).toBe(false);
  });

  test("does not fire when disabled (interval unset)", async () => {
    const streamFn = createMockStreamFunction([
      planCall([{ text: "step A", status: "pending" }]),
      noopCall(),
      noopCall(),
      finalText(),
    ]);
    await makeAgent(streamFn, undefined).prompt(userMsg());
    expect(streamFn.contexts.some(hasReminder)).toBe(false);
  });

  test("resets cadence on a plan update — no double-nudge right after", async () => {
    const streamFn = createMockStreamFunction([
      planCall([{ text: "step A", status: "pending" }]), // turn1: surfaced
      noopCall(), // turn2
      noopCall(), // turn3
      planCall([{ text: "step A", status: "in_progress" }]), // turn4: reminder fires at top, then plan updated
      finalText(), // turn5: must NOT re-fire (update reset the counter)
    ]);
    await makeAgent(streamFn, 2).prompt(userMsg());
    expect(hasReminder(streamFn.contexts[3])).toBe(true); // fired at turn4
    // The turn4 reminder persists in the conversation; the plan update reset the cadence,
    // so no *second* reminder is injected at turn5 (count stays 1, not 2).
    expect(countReminders(streamFn.contexts[4])).toBe(1);
  });

  test("survives compaction — session plan state drives the reminder across a re-prompt + compaction", async () => {
    const nativeCompactFn: NativeCompactFn = async () => ({ status: "ok", summary: "SUMMARY" });
    const streamFn = createMockStreamFunction([
      planCall([{ text: "step A", status: "pending" }]), // prompt1 turn1: set plan
      finalText(), // prompt1 turn2: end
      finalText(), // prompt2 turn1: after compaction
    ]);
    // contextWindow 200k, reservePercent 70 → threshold 60k tokens. Prompt2's ~70k-token user
    // message trips compaction at the top of prompt2's loop; being > 50k it uses the NATIVE
    // path (no stream call, so indices stay clean). The plan tool_result is summarized away,
    // but the Agent's session-level currentPlan (set in prompt1) still drives the reminder.
    const agent = new Agent(TEST_MODEL, [{ label: "sys", content: "sys" }], [planTool(), noopTool()], {
      effort: "medium",
      llmMsgStreamFn: streamFn,
      llmCompactionFn: nativeCompactFn,
      compaction: { reservePercent: 70, keepRecentTokens: 0 },
      planReminderIntervalTurns: 5, // high, so only the compaction path can recite here
    });
    await agent.prompt(userMsg()); // prompt1: sets the plan, ends
    const result = await agent.prompt({ role: "user", content: "x".repeat(280_000), timestamp: Date.now() });

    // The plan tool_result was compacted away, but the reminder still names the step
    // (read from session-level currentPlan, not the conversation).
    expect(
      result.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("do not end your turn until each") &&
          m.content.includes("step A"),
      ),
    ).toBe(true);
  });

  test("does not fire before any plan exists", async () => {
    const streamFn = createMockStreamFunction([noopCall(), noopCall(), noopCall(), finalText()]);
    await makeAgent(streamFn, 1).prompt(userMsg());
    expect(streamFn.contexts.some(hasReminder)).toBe(false);
  });
});
