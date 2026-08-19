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
  "Everything dilates with it: physics, movement, a prompt's hold, and `task.wait`/`task.delay` " +
  "countdowns — measured on a `task.wait(5)` at 0.2, which took the expected ~25 real seconds. A slowed " +
  "round really is the same round, slower, so a timing rule holds whatever scale it was tested at. " +
  "Keys work normally at any scale, movement and action keys alike — a fresh press at 0.2 was measured " +
  "moving the character at the correctly scaled rate. " +
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
