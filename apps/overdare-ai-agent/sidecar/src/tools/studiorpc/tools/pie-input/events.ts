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

/** How long Studio converges a `look` before reporting what it got, unless told otherwise. */
export const DEFAULT_LOOK_TIMEOUT_MS = 2_000;

/** How long a `press` holds when the caller does not say. */
// A down/up pair in the same engine tick can reach the input layer without giving
// Slate a frame in which to establish capture and activate a button.  The public
// `press` shorthand is the recommended click path, so its default must be a real
// human-sized tap rather than two adjacent messages.
const DEFAULT_PRESS_DURATION_MS = 100;

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

/**
 * Turn the view by an angle, through the game's own look input. Angles rather than
 * mouse deltas because the delta→degrees curve is the game's sensitivity setting,
 * unknowable from outside; Studio feeds the look axes a frame at a time until the
 * camera reports the requested rotation, and returns how far it actually turned.
 * A game whose camera the player cannot turn (isometric, scripted, cutscene)
 * answers `blocked` — that is the game's answer, worth reporting as play-test
 * evidence, not a tool failure. A view already against the game's pitch limit
 * answers `clamped` instead, which is a different fact about a working camera and
 * used to be reported as `blocked` because nothing moved during the event.
 */
const lookEventSchema = z.object({
  type: z.literal("look"),
  yawDegrees: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe(
      "How far to turn from where the view faces now. Right is positive. This is relative, so to face " +
        "something in particular read the camera first. Measured against the world, a facing of 0 looks " +
        "down -Z, +90 looks down +X, and 180 looks down +Z. Note that the `facing` this reply gives you is " +
        "the negation of the Orientation.Y that studiorpc_viewport_camera_read reports for the same camera, " +
        "so do not mix the two: work in one or the other. The reliable check on either is where the camera " +
        "sits relative to the character, since it trails behind the way the view is pointed. One play test " +
        "spent eight calls rediscovering the convention by trial.",
    ),
  pitchDegrees: z.number().min(-89).max(89).optional().describe("Up is positive."),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(5_000)
    .optional()
    .describe(
      "Budget for converging before Studio reports what it got. Defaults to 2000, and a turn much over 90 " +
        "degrees usually wants more than that or wants splitting in two — one 180-degree turn stopped at 123 " +
        "on an 800ms budget. Running out mid-turn (`timedOut`), or never moving at all (`blocked`), cancels " +
        "whatever the batch had queued behind the look rather than sending it at a view pointing somewhere " +
        "unintended: those two shots would otherwise go into empty ground and read as the game swallowing " +
        "input. `clamped` is not a failure — it is the game refusing to turn further, so the rest of the " +
        "batch runs. The budget is charged in full against the batch's 10s limit whether or not the turn " +
        "needs it.",
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
  timeScale: z
    .number()
    .min(0.05)
    .max(10)
    .optional()
    .describe(
      "Clock speed for this wait only, restored the moment it ends. durationMs stays real time, so the " +
        "game time covered is durationMs x timeScale: 10s at 10 skips 100 game-seconds. Leave it out and " +
        "the wait runs at whatever scale the session is already on, changing nothing. " +
        "Known defect: a key pressed while the clock is already slowed moves the character nothing at all — " +
        "zero, not merely slower. A key already held when the scale drops keeps moving and scales " +
        "correctly, so putting timeScale on the wait *between* a down and an up works; a press at a " +
        "session that is already slowed does not. Simpler and safer at any scale below 1: move with " +
        "studiorpc_game_character_move_to, which navigation drives and which is unaffected.",
    ),
});

export const inputEventSchema = z.discriminatedUnion("type", [
  keyEventSchema,
  pointerMoveEventSchema,
  pointerButtonEventSchema,
  lookEventSchema,
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
      "look: turn the view by yawDegrees (right is positive) and pitchDegrees (up is positive), the way the " +
      "player's own camera input would — use it to see what is beside or behind the character before taking " +
      "a screenshot. The result's looks[] reports how far the view actually turned, in one of four states. " +
      "reached got there. clamped is the view against a limit the game sets — looking further up when already " +
      "at the top is this, and it is a normal thing to do before firing, so the rest of the batch still runs. " +
      "blocked means this game does not let the player turn the view at all (fixed or scripted camera), which " +
      "is an answer about the game rather than a tool failure. timedOut ran out of budget part-way round. " +
      "Those last two leave the view somewhere nobody chose, so they cancel whatever the batch had queued " +
      "behind the look rather than firing it at the wrong quadrant. " +
      "mouseDelta: relative motion, requires a captured mouse. " +
      "scroll: wheel notches at the pointer. " +
      "textInput: printable text typed into whatever has focus, so the play test must be the focused window. " +
      "wait: durationMs between events, optionally with a timeScale that lasts only for that wait — the way " +
      "to run a round out to its timeout without spending the real seconds. " +
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
/**
 * Accepts a pointer event written with x and y at the top level. `position` is a
 * nested object and writing it flat is the natural mistake — the validator answers
 * that with "events.0.position: Required", which names a field the caller thought
 * they had supplied. Folding it costs nothing and the batch reads the same either way.
 */
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

/**
 * Expands press shorthand, and records which authored event each expanded one came
 * from. Studio validates the expanded batch, so without the map its errors name an
 * index the caller never wrote: a two-event batch reported a failure at `events[4]`.
 */
export function expandWithOrigin(events: InputEvent[]): { sent: InputEvent[]; origin: number[] } {
  const expanded: InputEvent[] = [];
  const origin: number[] = [];

  for (const [authoredIndex, original] of events.entries()) {
    const push = (event: InputEvent) => {
      expanded.push(event);
      origin.push(authoredIndex);
    };
    /* A pointerButton used to have no position field at all, so a position sent with
     * one was dropped by schema parsing and the click landed wherever the pointer
     * already sat — the middle of the viewport, on the UI root rather than the button.
     * Nothing reported a problem: the sequence completed and pointerUpSameLeaf was
     * true, because down and up did hit the same wrong widget. Moving first is what
     * makes a button take the click, so the position now expands into that move. */
    let event = original;
    if (event.type === "pointerButton" && event.position !== undefined) {
      const { position, ...rest } = event;
      push({ type: "pointerMove", position });
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

  return { sent: expanded, origin };
}

export function expandShorthand(events: InputEvent[]): InputEvent[] {
  return expandWithOrigin(events).sent;
}

/**
 * Batch rules Studio enforces in ValidateEvents(): no double press, no release
 * of an unpressed key, nothing still held when the batch ends, and at most
 * MAX_TOTAL_DURATION_MS of waiting. Checking here turns a Studio error code into
 * a message that names the offending event.
 */
export function validateBatch(events: InputEvent[], origin?: number[]): string | undefined {
  /* Report the authored index, not the expanded one. A press becomes down/wait/up,
   * so a two-event batch used to fail at `events[4]` — an event the caller never
   * wrote and could not go looking for. */
  const at = (index: number) => `events[${origin?.[index] ?? index}]`;
  const heldKeys = new Set<string>();
  const heldButtons = new Set<string>();
  let totalDurationMs = 0;

  for (const [index, event] of events.entries()) {
    if (event.type === "look") {
      if (!event.yawDegrees && !event.pitchDegrees) {
        return `${at(index)}: look with no rotation — give yawDegrees or pitchDegrees (lookOutOfRange).`;
      }
      // Converging may take this much real time, so it spends the same budget waits do.
      const lookBudgetMs = event.timeoutMs ?? DEFAULT_LOOK_TIMEOUT_MS;
      totalDurationMs += lookBudgetMs;
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        // Naming the look as the offender without saying what it charged reads as a bug,
        // since a turn that finishes in milliseconds still spends its whole timeout here.
        // Run 51 lost a call and a retry to exactly that.
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
      // A press is self-balancing, so it only conflicts with something already held.
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
      totalDurationMs += event.durationMs;
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        return (
          `${at(index)}: total wait ${totalDurationMs}ms exceeds the ${MAX_TOTAL_DURATION_MS}ms batch limit ` +
          "(totalDurationExceeded). Every press durationMs is a hold and counts too, so the sum can exceed " +
          "what the wait events alone add up to. Split the input across several calls."
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

/** Sum of the batch's `wait` durations and `look` budgets; the caller's RPC timeout budget. */
export function totalWaitMs(events: InputEvent[]): number {
  return events.reduce((sum, event) => {
    if (event.type === "wait") return sum + event.durationMs;
    if (event.type === "look") return sum + (event.timeoutMs ?? DEFAULT_LOOK_TIMEOUT_MS);
    return sum;
  }, 0);
}
