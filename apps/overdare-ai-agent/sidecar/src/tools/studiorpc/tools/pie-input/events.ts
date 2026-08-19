// @summary PIE input event schema and batch rules mirroring Studio-side validation.

import { z } from "zod";

/**
 * Keys Studio accepts; mirrors GetAllowedKeys() in PIEInputSimulator.cpp.
 *
 * The names are the platform's own `Enum.KeyCode` names, so a key a script binds can be sent
 * under the name the script used. Digits and Return also answer to the shorthand a caller is
 * likelier to type — "5" and "Enter" reach the same keys as "Five" and "Return".
 */
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

/** Studio rejects a batch above this many events. */
export const MAX_EVENT_COUNT = 64;
/**
 * Real time one batch may spend. Studio enforces the same number and rejects anything over it.
 *
 * It was 10s, and the 10s kept pushing callers into worse shapes. playtest10 wanted a 40.5s
 * wait, was refused, fell back to repeating 10s waits, and was then warned for a doom loop —
 * the harness scolding the workaround the harness forced. playtest11 walked an 11,000-unit
 * route in 8000, 7000 and 9500ms presses of W, each chunk costing a round trip whose model
 * thinking is about five seconds.
 *
 * The limit is policy, not capacity: Studio schedules a sequence across frames rather than
 * holding the game thread, so a long batch does not freeze anything. And a wait with an
 * `until` returns the moment its condition is true, so a long timeout costs nothing when the
 * thing actually happens — a short ceiling was buying polling, not safety.
 */
export const MAX_TOTAL_DURATION_MS = 60_000;
/**
 * What a conditional wait costs against the batch ceiling. It is not its timeout: a wait that
 * names what it is waiting for returns when that happens, and charging the whole allowance refused
 * batches that would have finished in seconds. The timeout is bounded separately, below.
 */
export const CONDITIONAL_WAIT_CHARGE_MS = 2_000;
/** The worst case a batch's conditional waits may add up to, so a batch can always end. */
export const MAX_CONDITIONAL_TIMEOUT_MS = 300_000;
/** Per-axis bound on a single `mouseDelta` event. */
export const MAX_MOUSE_DELTA = 4096;
/** Wheel notches Studio accepts in one `scroll` event. */
export const MAX_SCROLL_DELTA = 10;

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
  .describe(
    'How long to hold, for action "press". Defaults to a tap. Ignored by down and up. This is real ' +
      "time, and a game that counts a hold counts it in game time — a ProximityPrompt's HoldDuration, a " +
      "charge meter, a channelled action. At a slowed clock the two are not the same number: at 0.2x a " +
      "1,200ms hold is 240ms of game time and a one-second prompt never fires. Divide by the scale, or " +
      "hold at normal speed.",
  );

const keyEventSchema = z.object({
  type: z.literal("key"),
  key: z.enum(ALLOWED_KEYS),
  action: z.enum(["down", "up", "press"]),
  durationMs: pressDurationSchema,
});

/**
 * Naming a UI element instead of a point. Studio resolves the name against the same walk
 * studiorpc_game_ui_browse reports from, so the rect a click lands on and the rect browse
 * showed you cannot disagree — they used to be computed separately, and that disagreement
 * was a defect nobody could reproduce from either side.
 *
 * It does not replace coordinates, because the two catch different things. A name reaches
 * the button wherever the layout put it; a coordinate proves the button is somewhere a
 * player could actually click. A control that has drifted off the edge of the screen still
 * answers to its name — which is why a failed lookup by name says where it is rather than
 * only that it is unreachable.
 */
const targetSchema = z
  .string()
  .min(1)
  .describe(
    "Name, runtime path, or on-screen label of the UI element to point at — StartButton, " +
      "PlayerGui.HUD.StartButton, or START all resolve. Studio takes its centre from the live layout, so " +
      "no rect has to be read first. When several match, the one on screen wins. A name that is not there " +
      "comes back with the closest names it did find; a name that is there but off screen or hidden comes " +
      "back saying where it is, which is a finding about the game rather than about the call.",
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
      "How far to turn from where the view faces now, in the same degrees everything else here reports: " +
        "a facing of 0 looks down -Z, +90 down -X, 180 down +Z, so **positive turns left** and negative " +
        "turns right. This is relative, so to face something in particular read the facing first and " +
        "subtract — `yawDegrees` and the `facing.yaw` in studiorpc_game_character_read, in this reply, and " +
        "in studiorpc_viewport_camera_read's Orientation.Y are one number in one frame, and adding this to " +
        "the facing you read is what you should get back. There used to be two conventions here, this one " +
        "negated against the camera's, and a play test spent eight calls rediscovering which was which " +
        "before walking its character back down the route it had just climbed.",
    ),
  pitchDegrees: z.number().min(-89).max(89).optional().describe("Up is positive."),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(5_000)
    .optional()
    .describe(
      "Budget for converging before Studio reports what it got. Leave it out and it is set from the angle " +
        "you asked for, which is what you want unless the game turns unusually slowly. " +
        "Running out mid-turn (`timedOut`), or never moving at all (`blocked`), cancels " +
        "whatever the batch had queued behind the look rather than sending it at a view pointing somewhere " +
        "unintended: those two shots would otherwise go into empty ground and read as the game swallowing " +
        "input. `clamped` is not a failure — it is the game refusing to turn further, so the rest of the " +
        "batch runs. The budget is charged in full against the batch's time limit whether or not the turn " +
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
  target: targetSchema
    .optional()
    .describe(
      "What to click, by name — the same resolution pointerMove's target does, so the rect comes from the " +
        "live layout instead of being read out of a ui section and copied. Give this or " +
        "position, not both. On down and up separately it is a drag: press down on one element and release " +
        "over another, with the pointer captured the whole way, which is the one gesture nothing else here " +
        "exercises.",
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

// `textInput` was removed rather than left in place to fail: this platform's 2D GUI has no
// text field class, so a typed character has nowhere in a game to land. Leaving the event
// authorable meant the failure arrived as "the game did not react", which cannot be told
// apart from a game defect. Studio rejects it too, for callers built against the old schema.

/**
 * What a wait is waiting for. Real time is the dominant hazard in a play test — one run's
 * first attempt died in ten real seconds — and the only way to wait for a state change used
 * to be polling studiorpc_game_ui_browse in a loop, where every call spends more of it.
 * Waiting on the condition inside the game removes the round trip entirely and returns the
 * instant it is true, so a generous timeout costs nothing when the game is quick.
 */
const untilSchema = z
  .union([
    z
      .object({
        instance: z
          .string()
          .min(1)
          .describe("Name of a live Workspace instance, as studiorpc_game_observe's instances section takes."),
        property: z
          .enum([
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
          ])
          .describe(
            "Which property to watch, reading the same value studiorpc_game_observe reports for it. " +
              "Orientation is in degrees and wraps, so a rotating part passes " +
              "through 359 to 0 rather than climbing past it — phrase a phase condition as a band you can " +
              "enter (atLeast 90 with atMost 180 in two waits) rather than a threshold it might jump.",
          ),
        equals: z.union([z.boolean(), z.number()]).optional(),
        atLeast: z.number().optional(),
        atMost: z.number().optional(),
      })
      .strict(),
    z
      .object({
        ui: z.string().min(1).describe("Name, path, or label of a UI element — the same resolution target uses."),
        textEquals: z.string().optional(),
        textContains: z.string().optional(),
      })
      .strict(),
    z
      .object({
        log: z
          .string()
          .min(1)
          .describe(
            "Substring of a log line — plain text, not a regular expression, because a pattern that has to " +
              "survive JSON escaping fails by silently never matching, which is indistinguishable from the " +
              "line never being printed. Only lines logged after this wait starts count, so a game that " +
              "prints the same transition every round cannot satisfy the wait with the previous round's line.",
          ),
      })
      .strict(),
  ])
  .describe(
    "Condition to wait for instead of waiting out the clock. durationMs becomes the timeout rather than the " +
      "duration. If it never comes true, the events queued behind the wait are cancelled rather than sent " +
      "into a state you did not expect — the same rule a failed look follows — and the reply says what the " +
      "condition was and what was actually true when time ran out.",
  );

const waitEventSchema = z.object({
  type: z.literal("wait"),
  durationMs: z.number().int().min(0).max(MAX_TOTAL_DURATION_MS),
  until: untilSchema.optional(),
  timeScale: z
    .number()
    .min(0.05)
    .max(10)
    .optional()
    .describe(
      "Clock speed for this wait only, restored the moment it ends. durationMs stays real time, so the " +
        "game time covered is durationMs x timeScale: 10s at 10 skips 100 game-seconds. Leave it out and " +
        "the wait runs at whatever scale the session is already on, changing nothing.",
    ),
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
    "Ordered input events applied to the PIE viewport. " +
      "key: A-Z, 0-9 (also spelled Zero-Nine), Up/Down/Left/Right, Space, Return, Tab, Escape, " +
      "Backspace, and the Left/Right Shift/Control/Alt modifiers — the platform's own Enum.KeyCode " +
      "names — with action down|up|press. " +
      "pointerMove: position.x/y are viewport-normalized 0..1, or target names a UI element and Studio " +
      "finds its centre from the live layout. " +
      "pointerButton: left|right with action down|up|press, at position or target. A down on one target and " +
      "an up on another is a drag, with the pointer captured throughout. " +
      "These arrive in Lua as UserInputType.Touch, not MouseButton1 — this is a touch platform. Activated " +
      "fires either way, so buttons behave normally and only code that inspects UserInputType is affected: a " +
      "drag or press-and-hold written the Roblox way, filtering on MouseButton1, ignores every event this " +
      "tool can send while the rest of the game keeps working. If a control responds to nothing and its " +
      "buttons are fine, check what its handler filters on before reporting it as broken. " +
      "look: turn the view by yawDegrees (positive turns left, the same frame every facing here is reported " +
      "in) and pitchDegrees (up is positive), the way the " +
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
      "wait: durationMs between events, optionally with a timeScale that lasts only for that wait — the way " +
      "to run a round out to its timeout without spending the real seconds. Give it an until and durationMs " +
      "becomes a timeout instead: it returns the moment a named instance property, a UI element's text or " +
      "visibility, or a log line comes true, which is what to reach for instead of polling in a loop. " +
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
/** Slower than any turn measured, so the budget below is never the reason one stops short. */
const LOOK_DEGREES_PER_SECOND = 60;
/** The most Studio accepts on one look. */
const MAX_LOOK_TIMEOUT_MS = 5_000;

/**
 * A budget that fits the turn being asked for.
 *
 * Studio defaults every look to 2000ms whatever the angle, and the description told callers to
 * raise it themselves past 90 degrees — a rule that has to be read, remembered and applied, and
 * playtest11 did none of the three: a 180-degree look ran out at 164.24 degrees and cancelled the
 * `E` press queued behind it, which cost the run a stage and a retry. Measured there, the view
 * turns about 82 degrees a second; budgeting for 60 leaves room and still lands inside the 5s
 * ceiling. A caller that names its own timeoutMs keeps it.
 */
function budgetForLook(event: { yawDegrees?: number; pitchDegrees?: number }): number {
  const widest = Math.max(Math.abs(event.yawDegrees ?? 0), Math.abs(event.pitchDegrees ?? 0));
  const needed = 1_000 + (widest * 1_000) / LOOK_DEGREES_PER_SECOND;
  return Math.min(MAX_LOOK_TIMEOUT_MS, Math.max(DEFAULT_LOOK_TIMEOUT_MS, Math.round(needed)));
}

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
    if (event.type === "look" && event.timeoutMs === undefined) {
      event = { ...event, timeoutMs: budgetForLook(event) };
    }
    if (event.type === "pointerButton" && event.position !== undefined) {
      const { position, ...rest } = event;
      push({ type: "pointerMove", position });
      event = rest as InputEvent;
    }
    /* A press names its target once and clicks where that resolved. Leaving the target on
     * the expanded down and up would resolve it twice, so a control that moved between the
     * two would be pressed in one place and released in another — a click that quietly
     * becomes a drag. Held down/up keep their own targets, because there that is the point. */
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
  let conditionalTimeoutMs = 0;

  for (const [index, event] of events.entries()) {
    if (event.type === "pointerMove" && (event.position === undefined) === (event.target === undefined)) {
      // Both is not a merge, it is two different intents; neither is not a move at all.
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
      /* A timeout too small for the angle is refused here rather than part-way round. playtest5
       * asked for 90 degrees in 600ms, got 82.35, and the look's failure cancelled the 34 events
       * queued behind it — in the middle of a real-time fight, which cost the run the sequence it
       * had spent the batch building. The number needed is not a guess: it is the same budget the
       * tool gives a look that does not name one. */
      if (event.timeoutMs !== undefined) {
        const needed = budgetForLook(event);
        if (event.timeoutMs < needed) {
          const widest = Math.max(Math.abs(event.yawDegrees ?? 0), Math.abs(event.pitchDegrees ?? 0));
          return (
            `${at(index)}: ${widest} degrees needs about ${needed}ms and this look allows ${event.timeoutMs}ms ` +
            "(lookTimeoutTooSmall). A look that runs out mid-turn cancels every event behind it in the batch, " +
            "so it is refused here instead. Raise timeoutMs, or leave it out and the tool budgets the turn."
          );
        }
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
      /* A conditional wait is charged what it will probably spend, not what it is allowed to.
       * The ceiling exists to bound how long Studio holds a sequence, and a wait that names what
       * it is waiting for returns the moment that comes true — the previous rule charged the whole
       * timeout anyway, so "start the run, wait for the loss line, wait for the reset line" was
       * refused at 60,150ms for a batch that would have taken a fraction of it. Splitting it is
       * not free either: the reset happened between the two calls and was never seen.
       * The timeout is still bounded, just against its own larger allowance below. */
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
          // Named "total wait" this reported a number the wait events do not add up to, and the
          // caller had to read the next sentence to find out the label was wrong.
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

/** Sum of the batch's `wait` durations and `look` budgets; the caller's RPC timeout budget. */
export function totalWaitMs(events: InputEvent[]): number {
  return events.reduce((sum, event) => {
    if (event.type === "wait") return sum + event.durationMs;
    if (event.type === "look") return sum + (event.timeoutMs ?? DEFAULT_LOOK_TIMEOUT_MS);
    return sum;
  }, 0);
}
