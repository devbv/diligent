// @summary Declares the Studio RPC method for starting a play test, optionally at a changed clock speed.
import { z } from "zod";
import type { CallRpc } from "../tools/pie-input/target";

export const method = "game.play";

export const description =
  "Play the game in OVERDARE Studio. It clears the existing log file. " +
  "Studio may already be playing when you arrive — opening a map with -OpenMap starts a play test on its " +
  "own — and calling this then changes the running session's clock rather than starting a fresh one. The " +
  "reply says so with `rescaledRunningSession`, which also tells you the game's own state is wherever the " +
  "last session left it rather than at the beginning. Pass restart: true when you want a clean one — that " +
  "is the stop and the play in one call, and studiorpc_game_stop is then only for leaving the game stopped. " +
  "timeScale sets how fast the whole play test's clock runs, and it is the only way to change the pace of a " +
  "session. The game's clock runs in real time and your own reasoning between two tool calls costs it just " +
  "as much as the calls do, so a timed round can expire while you are still deciding — start it at 0.2 and " +
  "the same round affords five times the calls. It applies to the server world as well as the client, which " +
  "matters because OVERDARE puts game rules in server Scripts: scaling only the client would slow the " +
  "character while the round timer and the rules kept running at full speed, which is a different game " +
  "rather than a slower one. " +
  "**It does not slow `task.wait`**, which is how almost every countdown in Lua is written. Measured on a " +
  "55-second `task.wait(1)` loop: 56 real seconds at 1, and 56 real seconds at 0.2. So a slowed session " +
  "gives you a slow character inside a round that expires on schedule — which is not the game running " +
  "slowly, it is a different game, and a timing rule tested that way was not tested. Until that is fixed, " +
  "test a timed round at 1 and give yourself the room by other means. Everything a script schedules " +
  "through the world — physics, movement, a prompt's hold — does dilate. " +
  "Known defect, and the one thing to plan around: a key pressed while the clock is already slowed moves " +
  "the character nothing at all. Not slowed — zero, measured five times out of five, where the identical " +
  "press at 1 covers about 500 units. Movement itself is dilated correctly; what fails is starting it, so " +
  "a key already held when the clock drops keeps moving and scales properly. " +
  "So at any scale below 1, move with studiorpc_game_character_move_to, which navigation drives and which " +
  "is unaffected. Keys at a slowed clock look exactly like a character wedged against a wall. " +
  "This is about movement and nothing else: an action key reaches the game's own script normally at any " +
  "scale, verified at 0.3 for a key the game reads through UserInputService. A run that took the warning to " +
  "mean all key input was suspect avoided the mechanic it had come to test, so it is worth being plain — " +
  "press action keys freely at any scale, and drive movement with move_to. " +
  "Leave it out and the session runs at 1. Stopping the play test always returns the clock to 1, so a scale " +
  "cannot leak into the next session or into someone else's measurement. " +
  "To skip ahead inside a running session — reaching a round's timeout without waiting it out — put " +
  "timeScale on a wait event in studiorpc_game_input_inject instead; that one lasts only as long as the " +
  "wait. Judge pace, feel, or whether something responded promptly only at 1: a delay the game schedules " +
  "for itself stretches with the world.";

export const params = z.object({
  numberOfPlayer: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "How many players Studio starts. Know exactly what a second one buys you, because driving and " +
        "watching are split. You can drive it: studiorpc_game_input_inject and " +
        "studiorpc_game_character_move_to both take a clientId, so any client studiorpc_game_pie_status " +
        "lists as injectable can be sent keys, pointer events and walk orders by id. You cannot watch it: " +
        "character reads, the UI tree, instance reads, studiorpc_game_observe, screenshots and the camera " +
        "take no clientId at all and always address the main play test — the injectable client with the " +
        "lowest pieInstance, the one pie_status marks targeted: true. So a two-player scenario is testable " +
        "exactly when player two's effect shows up in player one's world: move them, then read from the " +
        "main client. A scenario whose evidence only exists on the second screen cannot be checked here. " +
        "Defaults to 1, and 1 is the right answer unless the game refuses to start without a second player.",
    ),
  timeScale: z
    .number()
    .min(0.05)
    .max(10)
    .optional()
    .describe(
      "Clock speed for the whole session: below 1 slows it, above 1 speeds it up. Defaults to 1, and the " +
        "range is 0.05 to 10 — asking for more is a validation error that leaves the play test stopped, so " +
        "the call after it fails too. " +
        "Read it back from studiorpc_game_pie_status, which reports the scale each world actually ended up " +
        "running at.",
    ),
  restart: z
    .boolean()
    .optional()
    .describe(
      "Stop the running play test first, so this starts a session from the beginning rather than joining " +
        "the one already up. Measured across 60 runs, 80 of 88 stops existed only to be followed by a play; " +
        "this is that pair in one call. Leave it off to rescale or rejoin what is running.",
    ),
});

/**
 * The stop has to happen before the play, and there is nowhere else to put it: the answer this
 * tool returns describes the session that the stop must already have cleared.
 */
export async function preCall(args: Record<string, unknown>, callRpc: CallRpc): Promise<void> {
  if (args.restart !== true) return;
  try {
    await callRpc("game.stop", {});
  } catch {
    // Stopping what is not running is the state the caller asked for. Raising here would make
    // `restart: true` fail from a stopped session — the one case where the caller cannot know
    // which it is, which is why the parameter exists.
  }
}

/** `restart` is this tool's own; Studio's game.play knows nothing about it. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { restart: _restart, ...rest } = args;
  return rest;
}
