// @summary PIE input event schema and batch rules mirroring Studio-side validation.

import { z } from "zod";

/** Keys Studio accepts; mirrors GetAllowedKeys() in PIEInputSimulator.cpp. */
export const ALLOWED_KEYS = ["W", "A", "S", "D", "Q", "E", "R", "SpaceBar", "LeftShift", "LeftControl"] as const;

/** Studio rejects a batch above this many events. */
export const MAX_EVENT_COUNT = 64;
/** Studio rejects a batch whose `wait` durations sum above this. */
export const MAX_TOTAL_DURATION_MS = 10_000;
/** Per-axis bound on a single `mouseDelta` event. */
export const MAX_MOUSE_DELTA = 4096;
/** Wheel notches Studio accepts in one `scroll` event. */
export const MAX_SCROLL_DELTA = 10;
/** Characters Studio accepts in one `textInput` event. */
export const MAX_TEXT_INPUT_LENGTH = 256;

/** How long a `press` holds when the caller does not say. 0 makes it a tap. */
const DEFAULT_PRESS_DURATION_MS = 0;

const pressDurationSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOTAL_DURATION_MS)
  .optional()
  .describe('How long to hold, for action "press". Defaults to a tap. Ignored by down and up.');

const keyEventSchema = z.object({
  type: z.literal("key"),
  key: z.enum(ALLOWED_KEYS),
  action: z.enum(["down", "up", "press"]),
  durationMs: pressDurationSchema,
});

const pointerMoveEventSchema = z.object({
  type: z.literal("pointerMove"),
  position: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
});

const pointerButtonEventSchema = z.object({
  type: z.literal("pointerButton"),
  button: z.enum(["left", "right"]),
  action: z.enum(["down", "up", "press"]),
  durationMs: pressDurationSchema,
});

const mouseDeltaEventSchema = z.object({
  type: z.literal("mouseDelta"),
  delta: z.object({
    x: z.number().min(-MAX_MOUSE_DELTA).max(MAX_MOUSE_DELTA),
    y: z.number().min(-MAX_MOUSE_DELTA).max(MAX_MOUSE_DELTA),
  }),
});

const scrollEventSchema = z.object({
  type: z.literal("scroll"),
  delta: z
    .number()
    .min(-MAX_SCROLL_DELTA)
    .max(MAX_SCROLL_DELTA)
    .describe("Wheel notches at the current pointer position. Positive scrolls up / zooms in."),
});

const textInputEventSchema = z.object({
  type: z.literal("textInput"),
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_INPUT_LENGTH)
    .describe("Printable text to type. Control characters are rejected — use key events for those."),
});

const waitEventSchema = z.object({
  type: z.literal("wait"),
  durationMs: z.number().int().min(0).max(MAX_TOTAL_DURATION_MS),
});

export const inputEventSchema = z.discriminatedUnion("type", [
  keyEventSchema,
  pointerMoveEventSchema,
  pointerButtonEventSchema,
  mouseDeltaEventSchema,
  scrollEventSchema,
  textInputEventSchema,
  waitEventSchema,
]);

export type InputEvent = z.infer<typeof inputEventSchema>;

export const inputEventsSchema = z
  .array(inputEventSchema)
  .min(1)
  .max(MAX_EVENT_COUNT)
  .describe(
    "Ordered input events applied to the PIE viewport. " +
      `key: ${ALLOWED_KEYS.join("/")} with action down|up|press. ` +
      "pointerMove: position.x/y are viewport-normalized 0..1. " +
      "pointerButton: left|right with action down|up|press. " +
      "mouseDelta: relative motion, requires a captured mouse. " +
      "scroll: wheel notches at the pointer. " +
      "textInput: printable text typed into whatever has focus, so the play test must be the focused window. " +
      "wait: durationMs between events. " +
      'Prefer action "press" with durationMs — it is one event instead of down/wait/up, and it can never ' +
      "leave input stuck down. Reach for down and up only when something else has to happen while the key " +
      "is held. Every down must have a matching up inside the same batch — Studio releases nothing across calls.",
  );

/**
 * Expand `press` into the down/wait/up Studio actually understands. Studio has no
 * press action, so this is purely a sidecar convenience — but it is the shape the
 * caller should reach for: one authored event instead of three, and no way to
 * leave a key held past the end of the batch.
 */
export function expandShorthand(events: InputEvent[]): InputEvent[] {
  const expanded: InputEvent[] = [];

  for (const event of events) {
    if ((event.type !== "key" && event.type !== "pointerButton") || event.action !== "press") {
      expanded.push(event);
      continue;
    }

    const { durationMs, ...held } = event;
    expanded.push({ ...held, action: "down" });
    const holdMs = durationMs ?? DEFAULT_PRESS_DURATION_MS;
    if (holdMs > 0) expanded.push({ type: "wait", durationMs: holdMs });
    expanded.push({ ...held, action: "up" });
  }

  return expanded;
}

/**
 * Batch rules Studio enforces in ValidateEvents(): no double press, no release
 * of an unpressed key, nothing still held when the batch ends, and at most
 * MAX_TOTAL_DURATION_MS of waiting. Checking here turns a Studio error code into
 * a message that names the offending event.
 */
export function validateBatch(events: InputEvent[]): string | undefined {
  const heldKeys = new Set<string>();
  const heldButtons = new Set<string>();
  let totalDurationMs = 0;

  for (const [index, event] of events.entries()) {
    if (event.type === "key" || event.type === "pointerButton") {
      const held = event.type === "key" ? heldKeys : heldButtons;
      const name = event.type === "key" ? event.key : event.button;
      const label = event.type === "key" ? "key" : "button";
      // A press is self-balancing, so it only conflicts with something already held.
      if (event.action === "press") {
        if (held.has(name)) return `events[${index}]: ${label} "${name}" is already down (unbalancedKeyAction).`;
        continue;
      }
      if (event.action === "down") {
        if (held.has(name)) return `events[${index}]: ${label} "${name}" is already down (unbalancedKeyAction).`;
        held.add(name);
      } else {
        if (!held.has(name)) return `events[${index}]: ${label} "${name}" was never pressed (unbalancedKeyAction).`;
        held.delete(name);
      }
      continue;
    }

    if (event.type === "wait") {
      totalDurationMs += event.durationMs;
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        return (
          `events[${index}]: total wait ${totalDurationMs}ms exceeds the ${MAX_TOTAL_DURATION_MS}ms batch limit ` +
          "(totalDurationExceeded). Split the input across several calls."
        );
      }
    }
  }

  const stillHeld = [...heldKeys, ...heldButtons];
  if (stillHeld.length > 0) {
    return (
      `Batch ends with ${stillHeld.join(", ")} still held (heldInputMustBeReleasedInBatch). ` +
      "Append the matching up events — Studio does not keep input held between calls."
    );
  }
  return undefined;
}

/** Sum of the batch's `wait` durations; the caller's RPC timeout budget. */
export function totalWaitMs(events: InputEvent[]): number {
  return events.reduce((sum, event) => (event.type === "wait" ? sum + event.durationMs : sum), 0);
}
