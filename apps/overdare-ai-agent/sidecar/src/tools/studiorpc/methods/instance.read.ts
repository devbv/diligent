import { z } from "zod";

export const method = "instance.read";

export const description =
  "Read instance properties from the level file by GUID, as the level was authored. Returns only known class " +
  "properties. Use recursive to include descendants. " +
  "While a play test runs this is the wrong tool for anything a script can change: it reads the saved file, so " +
  "a part a script has made transparent, passable or invisible still reads here exactly as it was saved. Use " +
  "studiorpc_game_observe for what the running game currently has — the names differ by one word and " +
  "the answers differ by everything.";

export const params = z.object({
  // Optional in the schema so that calling with no arguments — which three testers did,
  // expecting the live tool's listing — is answered with a sentence naming the tool they
  // wanted, instead of a bare "guid: Required" from the validator.
  guid: z
    .string()
    .optional()
    .describe(
      "GUID of the instance to read. Tools that report a GUID name it instanceGuid; pass that same value here. " +
        "This tool has no listing mode: for everything in the running game, call " +
        "studiorpc_game_observe with instances set to search the world.",
    ),
  recursive: z.boolean().describe("If true, include all descendants recursively").default(false),
});

/** Accepts instanceGuid, the name every tool that reports a GUID uses, as guid. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.guid === undefined && typeof args.instanceGuid === "string") {
    const { instanceGuid, ...rest } = args;
    return { ...rest, guid: instanceGuid };
  }
  return args;
}
