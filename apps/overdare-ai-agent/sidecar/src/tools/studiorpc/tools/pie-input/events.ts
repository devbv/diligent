// @summary PIE input event schema and batch rules mirroring Studio-side validation.

import { z } from "zod";
export const ALLOWED_KEYS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "Up",
  "Down",
  "Left",
  "Right",
  "Space",
  "SpaceBar",
  "Return",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "LeftShift",
  "RightShift",
  "LeftControl",
  "RightControl",
  "LeftAlt",
  "RightAlt",
] as const;
export const MAX_EVENT_COUNT = 64;
export const MAX_TOTAL_DURATION_MS = 60_000;
export const CONDITIONAL_WAIT_CHARGE_MS = 2_000;
export const MAX_CONDITIONAL_TIMEOUT_MS = 300_000;
export const MAX_MOUSE_DELTA = 4096;
export const MAX_SCROLL_DELTA = 10;
export const DEFAULT_LOOK_TIMEOUT_MS = 2_000;
const DEFAULT_PRESS_DURATION_MS = 100;

const pressDurationSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOTAL_DURATION_MS)
  .optional()
  .describe('Real milliseconds to hold action "press"; ignored by down/up and defaults to a tap.');

const keyEventSchema = z.object({
  type: z.literal("key"),
  key: z.enum(ALLOWED_KEYS),
  action: z.enum(["down", "up", "press"]),
  durationMs: pressDurationSchema,
});
const targetSchema = z
  .string()
  .min(1)
  .describe(
    "UI name, runtime path, or visible label. Studio resolves the live rect center, prefers an on-screen " +
      "match, and reports suggestions or off-screen state when it cannot click the target.",
  );

const pointerMoveEventSchema = z.object({
  type: z.literal("pointerMove"),
  position: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional(),
  target: targetSchema.optional(),
});
const lookEventSchema = z.object({
  type: z.literal("look"),
  yawDegrees: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe(
      "Relative yaw in the same frame as character facing and camera Orientation.Y: 0 faces -Z, +90 faces " +
        "-X, and positive turns left.",
    ),
  pitchDegrees: z.number().min(-89).max(89).optional().describe("Up is positive."),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(5_000)
    .optional()
    .describe(
      "Convergence budget. The angle supplies a safe default and raises smaller values, reported in " +
        "raisedLookTimeouts. blocked/timedOut cancel later events; reached/clamped continue. The full budget " +
        "counts toward the batch limit.",
    ),
});

const pointerButtonEventSchema = z.object({
  type: z.literal("pointerButton"),
  button: z.enum(["left", "right"]),
  action: z.enum(["down", "up", "press"]),
  durationMs: pressDurationSchema,
  position: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .optional()
    .describe(
      "Where to click, as a viewport fraction. Expanded into a pointerMove before the press, because a " +
        "button only takes the click if the pointer is already over it.",
    ),
  target: targetSchema
    .optional()
    .describe(
      "UI target resolved from the live layout. Give target or position, not both. Separate down/up targets " +
        "form a captured drag.",
    ),
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
const instanceName = z
  .string()
  .min(1)
  .describe("Name of a live Workspace instance, as studiorpc_game_observe's instances section takes.");

const instancePropertyCondition = z
  .object({
    instance: instanceName,
    property: z.enum([
      "CanCollide",
      "CanTouch",
      "CanQuery",
      "Anchored",
      "Transparency",
      "Position.X",
      "Position.Y",
      "Position.Z",
      "Orientation.X",
      "Orientation.Y",
      "Orientation.Z",
    ]),
    equals: z.union([z.boolean(), z.number()]).optional(),
    atLeast: z.number().optional(),
    atMost: z.number().optional(),
  })
  .strict()
  .refine((value) => [value.equals, value.atLeast, value.atMost].filter((entry) => entry !== undefined).length === 1, {
    message: "Give exactly one of equals, atLeast, or atMost.",
  });

const uiTarget = z.string().min(1).describe("Name, path, or label of a UI element — the same resolution target uses.");
const uiCondition = z
  .union([
    z.object({ ui: uiTarget, textEquals: z.string() }).strict(),
    z.object({ ui: uiTarget, textContains: z.string() }).strict(),
    z.object({ ui: uiTarget, onScreen: z.boolean() }).strict(),
    z.object({ ui: uiTarget, visible: z.boolean() }).strict(),
  ])
  .describe(
    "One UI comparison: choose exactly one of textEquals, textContains, onScreen, or visible. " +
      "Use separate waits when two observations matter.",
  );

const untilSchema = z
  .union([
    z.object({ instance: instanceName, exists: z.boolean() }).strict(),
    instancePropertyCondition,
    uiCondition,
    z
      .object({
        log: z
          .string()
          .min(1)
          .describe(
            "Plain-text log substring. Only lines emitted after this wait starts count, so an earlier round " +
              "cannot satisfy a later wait.",
          ),
      })
      .strict(),
  ])
  .describe(
    "Instance, UI, or log condition. durationMs becomes its timeout. A timeout cancels later events and " +
      "reports the expected and observed state.",
  );

const waitEventSchema = z.object({
  type: z.literal("wait"),
  durationMs: z.number().int().min(0).max(MAX_TOTAL_DURATION_MS),
  until: untilSchema.optional(),
});

export const inputEventSchema = z.discriminatedUnion("type", [
  keyEventSchema,
  pointerMoveEventSchema,
  pointerButtonEventSchema,
  lookEventSchema,
  mouseDeltaEventSchema,
  scrollEventSchema,
  waitEventSchema,
]);

export type InputEvent = z.infer<typeof inputEventSchema>;

export const inputEventsSchema = z
  .array(inputEventSchema)
  .min(1)
  .max(MAX_EVENT_COUNT)
  .describe(
    "Ordered PIE input, up to 64 events. Keys use Enum.KeyCode names and down/up/press. pointerMove and " +
      "pointerButton take a normalized position or live UI target; separate down/up positions form a drag. " +
      "Pointer buttons arrive to Lua as Touch, while Activated still fires. look reports reached, clamped, " +
      "blocked, or timedOut. mouseDelta needs capture; scroll uses wheel notches. wait uses real durationMs " +
      "and optional instance/UI/log conditions. Every down must be released " +
      "inside the batch; prefer press for self-balanced input.",
  );
export function normalizeEventShapes(events: unknown): unknown {
  if (!Array.isArray(events)) return events;
  return events.map((event) => {
    if (!event || typeof event !== "object") return event;
    const shape = event as Record<string, unknown>;
    if (shape.position === undefined && typeof shape.x === "number" && typeof shape.y === "number") {
      const { x, y, ...rest } = shape;
      return { ...rest, position: { x, y } };
    }
    return event;
  });
}
const LOOK_DEGREES_PER_SECOND = 60;
const MAX_LOOK_TIMEOUT_MS = 5_000;
function budgetForLook(event: { yawDegrees?: number; pitchDegrees?: number }): number {
  const widest = Math.max(Math.abs(event.yawDegrees ?? 0), Math.abs(event.pitchDegrees ?? 0));
  const needed = 1_000 + (widest * 1_000) / LOOK_DEGREES_PER_SECOND;
  return Math.min(MAX_LOOK_TIMEOUT_MS, Math.max(DEFAULT_LOOK_TIMEOUT_MS, Math.round(needed)));
}

export function expandWithOrigin(events: InputEvent[]): {
  sent: InputEvent[];
  origin: number[];
  raisedLooks: { event: number; from: number; to: number }[];
} {
  const expanded: InputEvent[] = [];
  const origin: number[] = [];
  const raisedLooks: { event: number; from: number; to: number }[] = [];

  for (const [authoredIndex, original] of events.entries()) {
    const push = (event: InputEvent) => {
      expanded.push(event);
      origin.push(authoredIndex);
    };
    let event = original;
    if (event.type === "look") {
      const needed = budgetForLook(event);
      if (event.timeoutMs === undefined) {
        event = { ...event, timeoutMs: needed };
      } else if (event.timeoutMs < needed) {
        raisedLooks.push({ event: authoredIndex, from: event.timeoutMs, to: needed });
        event = { ...event, timeoutMs: needed };
      }
    }
    if (event.type === "pointerButton" && event.position !== undefined) {
      const { position, ...rest } = event;
      push({ type: "pointerMove", position });
      event = rest as InputEvent;
    }
    if (event.type === "pointerButton" && event.action === "press" && event.target !== undefined) {
      const { target, ...rest } = event;
      push({ type: "pointerMove", target });
      event = rest as InputEvent;
    }

    if ((event.type !== "key" && event.type !== "pointerButton") || event.action !== "press") {
      push(event);
      continue;
    }

    const { durationMs, ...held } = event;
    push({ ...held, action: "down" });
    const holdMs = durationMs ?? DEFAULT_PRESS_DURATION_MS;
    if (holdMs > 0) push({ type: "wait", durationMs: holdMs });
    push({ ...held, action: "up" });
  }

  return { sent: expanded, origin, raisedLooks };
}

export function expandShorthand(events: InputEvent[]): InputEvent[] {
  return expandWithOrigin(events).sent;
}
export function validateBatch(events: InputEvent[], origin?: number[]): string | undefined {
  const at = (index: number) => `events[${origin?.[index] ?? index}]`;
  const heldKeys = new Set<string>();
  const heldButtons = new Set<string>();
  let totalDurationMs = 0;
  let conditionalTimeoutMs = 0;

  for (const [index, event] of events.entries()) {
    if (event.type === "pointerMove" && (event.position === undefined) === (event.target === undefined)) {
      return event.position === undefined
        ? `${at(index)}: pointerMove needs either position or target (missingTargetOrPosition).`
        : `${at(index)}: pointerMove has both position and target — give one (targetAndPositionTogether).`;
    }
    if (event.type === "pointerButton" && event.position !== undefined && event.target !== undefined) {
      return `${at(index)}: pointerButton has both position and target — give one (targetAndPositionTogether).`;
    }
    if (event.type === "wait" && event.until !== undefined && event.durationMs <= 0) {
      return (
        `${at(index)}: a wait with an until needs durationMs as its timeout (conditionalWaitNeedsTimeout). ` +
        "Zero means look once and give up, which never waits for anything."
      );
    }

    if (event.type === "look") {
      if (!event.yawDegrees && !event.pitchDegrees) {
        return `${at(index)}: look with no rotation — give yawDegrees or pitchDegrees (lookOutOfRange).`;
      }
      const lookBudgetMs = Math.max(event.timeoutMs ?? DEFAULT_LOOK_TIMEOUT_MS, budgetForLook(event));
      totalDurationMs += lookBudgetMs;
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        return (
          `${at(index)}: waits, presses and look timeouts total ${totalDurationMs}ms, above the ` +
          `${MAX_TOTAL_DURATION_MS}ms batch limit (totalDurationExceeded). This look is charged the ` +
          `${lookBudgetMs}ms it is allowed to take, not the time it will actually take — pass a smaller ` +
          `timeoutMs on it, or split the input across several calls.`
        );
      }
      continue;
    }

    if (event.type === "key" || event.type === "pointerButton") {
      const held = event.type === "key" ? heldKeys : heldButtons;
      const name = event.type === "key" ? event.key : event.button;
      const label = event.type === "key" ? "key" : "button";
      if (event.action === "press") {
        if (held.has(name)) return `${at(index)}: ${label} "${name}" is already down (unbalancedKeyAction).`;
        continue;
      }
      if (event.action === "down") {
        if (held.has(name)) return `${at(index)}: ${label} "${name}" is already down (unbalancedKeyAction).`;
        held.add(name);
      } else {
        if (!held.has(name)) return `${at(index)}: ${label} "${name}" was never pressed (unbalancedKeyAction).`;
        held.delete(name);
      }
      continue;
    }

    if (event.type === "wait") {
      totalDurationMs += event.until === undefined ? event.durationMs : CONDITIONAL_WAIT_CHARGE_MS;
      conditionalTimeoutMs += event.until === undefined ? 0 : event.durationMs;
      if (conditionalTimeoutMs > MAX_CONDITIONAL_TIMEOUT_MS) {
        return (
          `${at(index)}: the batch's conditional waits could sit for ${conditionalTimeoutMs}ms between them, ` +
          `over the ${MAX_CONDITIONAL_TIMEOUT_MS}ms ceiling (conditionalTimeoutExceeded). Each one returns as ` +
          "soon as its condition comes true, so this is the worst case rather than the expected cost — but " +
          "the batch still has to be able to end. Shorten a timeout or drop a condition."
        );
      }
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        return (
          `${at(index)}: the batch spends ${totalDurationMs}ms, over the ${MAX_TOTAL_DURATION_MS}ms limit ` +
          "(totalDurationExceeded). That is every wait plus every press durationMs, since a press is a " +
          "hold and spends its time the same way. Before splitting this across calls, check whether it " +
          "wants an `until` instead: a wait that names what it is waiting for returns the moment that " +
          "comes true, so its durationMs is a timeout it usually does not spend."
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
export function totalWaitMs(events: InputEvent[]): number {
  return events.reduce((sum, event) => {
    if (event.type === "wait") return sum + event.durationMs;
    if (event.type === "look") return sum + (event.timeoutMs ?? DEFAULT_LOOK_TIMEOUT_MS);
    return sum;
  }, 0);
}
