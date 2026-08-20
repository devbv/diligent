// @summary Declares the Studio RPC method for starting a play test, optionally at a changed clock speed.
import { z } from "zod";
import type { CallRpc } from "../tools/pie-input/target";

export const method = "game.play";

export const description =
  "Start or rescale the OVERDARE Studio play test. Calling it while PIE is already running changes that " +
  "session and returns `rescaledRunningSession`; pass restart: true to stop it first and start clean. " +
  "timeScale applies to server and client worlds, including physics, movement, prompts, task.wait and " +
  "task.delay. It defaults to 1 and is reset to 1 when play stops. Use a wait event's timeScale for a " +
  "temporary fast-forward, and use scale 1 when judging pace or responsiveness.";

export const params = z.object({
  numberOfPlayer: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Number of PIE players. Defaults to 1. Input and move tools can target another injectable client by " +
        "clientId, but UI, screenshots, camera, and game.observe read the targeted main client.",
    ),
  timeScale: z
    .number()
    .min(0.05)
    .max(10)
    .optional()
    .describe("Session clock speed, 0.05 to 10. Defaults to 1; verify it with studiorpc_game_pie_status."),
  restart: z
    .boolean()
    .optional()
    .describe("Stop an existing play test before starting, so the game begins from a clean session."),
});
export async function preCall(args: Record<string, unknown>, callRpc: CallRpc): Promise<void> {
  if (args.restart !== true) return;
  await callRpc("game.stop", {});
}
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { restart: _restart, ...rest } = args;
  return rest;
}
