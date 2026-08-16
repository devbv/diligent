// @summary Declares the Studio RPC method for starting a play test, optionally at a changed clock speed.
import { z } from "zod";

export const method = "game.play";

export const description =
  "Play the game in OVERDARE Studio. It clears the existing log file. " +
  "Studio may already be playing when you arrive — opening a map with -OpenMap starts a play test on its " +
  "own — and calling this then changes the running session's clock rather than starting a fresh one. The " +
  "reply says so with `rescaledRunningSession`, which also tells you the game's own state is wherever the " +
  "last session left it rather than at the beginning. Call studiorpc_game_stop first when you want a clean " +
  "one. " +
  "timeScale sets how fast the whole play test's clock runs, and it is the only way to change the pace of a " +
  "session. The game's clock runs in real time and your own reasoning between two tool calls costs it just " +
  "as much as the calls do, so a timed round can expire while you are still deciding — start it at 0.2 and " +
  "the same round affords five times the calls. It applies to the server world as well as the client, which " +
  "matters because OVERDARE puts game rules in server Scripts: scaling only the client would slow the " +
  "character while the round timer and the rules kept running at full speed, which is a different game " +
  "rather than a slower one. What it cannot slow is a script timing itself off the wall clock, since that " +
  "never asks the world what time it is. " +
  "Known defect, and the one thing to plan around: a key pressed while the clock is already slowed moves " +
  "the character nothing at all. Not slowed — zero, measured five times out of five, where the identical " +
  "press at 1 covers about 500 units. Movement itself is dilated correctly; what fails is starting it, so " +
  "a key already held when the clock drops keeps moving and scales properly. " +
  "So at any scale below 1, move with studiorpc_game_character_move_to, which navigation drives and which " +
  "is unaffected. Keys at a slowed clock look exactly like a character wedged against a wall. " +
  "Leave it out and the session runs at 1. Stopping the play test always returns the clock to 1, so a scale " +
  "cannot leak into the next session or into someone else's measurement. " +
  "To skip ahead inside a running session — reaching a round's timeout without waiting it out — put " +
  "timeScale on a wait event in studiorpc_game_input_inject instead; that one lasts only as long as the " +
  "wait. Judge pace, feel, or whether something responded promptly only at 1: a delay the game schedules " +
  "for itself stretches with the world.";

export const params = z.object({
  numberOfPlayer: z.number().int().positive().optional(),
  timeScale: z
    .number()
    .min(0.05)
    .max(10)
    .optional()
    .describe(
      "Clock speed for the whole session: below 1 slows it, above 1 speeds it up. Defaults to 1. " +
        "Read it back from studiorpc_game_pie_status, which reports the scale each world actually ended up " +
        "running at.",
    ),
});
