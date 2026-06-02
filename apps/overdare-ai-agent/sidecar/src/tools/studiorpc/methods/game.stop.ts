import { z } from "zod";

export const method = "game.stop";

export const description = "Stop the currently playing game in OVERDARE Studio.";

export const params = z.object({});
