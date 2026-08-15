// @summary Declares the Studio RPC method for reading and setting the play test's clock speed.
import { z } from "zod";

export const method = "game.time.scale";

export const description =
  "Read or set how fast the running play test's clock moves, where 1 is real time. " +
  "The game does not pause while you think, so a timed round loses seconds to the gap between your tool " +
  "calls; setting the scale to 0.2 gives you five times as many calls inside the same round without changing " +
  "what the game does. Raise it above 1 to reach a timeout or a slow state sooner than waiting would. " +
  "Call it with no arguments to read the current scale. That reply also carries `measuredScale`, the ratio " +
  "of the world's own frame delta to real time, which is the world reporting how dilated it actually is " +
  "rather than repeating what it was told — check that rather than inferring dilation from a countdown, " +
  "since a game timing itself off the wall clock will not slow however well the scale took. Set it back to " +
  "1 before judging anything about timing or feel, because at any other scale the pace you observe is not " +
  "the pace a player gets. " +
  "This drives the world's time dilation, so it governs physics, animation and anything the game schedules " +
  "off game time — but not code that reads the wall clock directly, which keeps running at real speed.";

export const params = z
  .object({
    scale: z
      .number()
      .min(0.05)
      .max(10)
      .optional()
      .describe("New clock speed: below 1 slows the game down, above 1 speeds it up. Omit to read the current one."),
  })
  .strict();
