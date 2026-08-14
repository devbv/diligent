// @summary Declares the Studio RPC method for reading an instance as the running game has it.
import { z } from "zod";

export const method = "game.instance.read";

export const description =
  "Read an instance as the running game currently has it, by its runtime name. " +
  "This is the live counterpart to studiorpc_instance_read, which reads the level as authored and so cannot " +
  "see anything a script changed after play started. When a script claims to have opened a door, dimmed a " +
  "light, or disabled a trigger, this is what tells you whether it actually did — CanCollide, CanTouch, " +
  "Transparency and the current CFrame come from the live instance, not the saved level. " +
  "Reach for it the moment the game's own log and what you can see disagree: a part can be made " +
  "see-through without being made passable, and only this shows the difference.";

export const params = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Runtime name of the instance, searched under the running Workspace (for example "Gate").'),
    instanceGuid: z
      .string()
      .min(1)
      .optional()
      .describe(
        "GUID of the instance, as any tool that reports one gives it. Instances a script created at run time " +
          "have no GUID, so look those up by name.",
      ),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.instanceGuid !== undefined, {
    message: "Pass either name or instanceGuid to say which instance to read.",
  });
