import { z } from "zod";

export const method = "game.play";

export const description = "Play the game in OVERDARE Studio. It clears the existing log file.";

export const params = z.object({
  numberOfPlayer: z.number().int().positive().optional(),
});
