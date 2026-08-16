// @summary Declares the Studio RPC method for reading an instance as the running game has it.
import { z } from "zod";

export const method = "game.instance.read";

export const description =
  "Read an instance as the running game currently has it, by its runtime name. " +
  "This is the live counterpart to studiorpc_instance_read, which reads the level as authored and so cannot " +
  "see anything a script changed after play started. When a script claims to have opened a door, dimmed a " +
  "light, or disabled a trigger, this is what tells you whether it actually did — CanCollide, CanTouch, " +
  "Transparency, Size and the current CFrame come from the live instance, not the saved level. " +
  "Size is how big the part actually is, which is what tells you how close counts as reaching it: pass it as " +
  "studiorpc_game_character_move_to's arrivalTolerance instead of guessing a number. Shape says whether that " +
  "size describes a Block, a Ball or a Cylinder — a 400x400x4 part is a disc or a square slab depending on " +
  "it, and a screenshot will not settle which. " +
  "Reach for it the moment the game's own log and what you can see disagree: a part can be made " +
  "see-through without being made passable, and only this shows the difference. " +
  "Call it with no arguments to list what sits directly in the running Workspace with its name, class, " +
  "position and size — that is the live counterpart to studiorpc_level_browse, and the way to find out what " +
  "a name is before asking about it. It stops at the top level on purpose, because a character's rig is " +
  "dozens of instances and would bury the handful you came for; raise maxDepth when you need inside " +
  "something, and the reply says how much was left out. " +
  "A name that is not in the running world answers `found: false` with the names that are, rather than " +
  "raising — so this is also how you check that something was deleted, and how you recover from a name " +
  "that a script chose differently from the level.";

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
    // Declared rather than only normalized: params are strict, so an undeclared key
    // is rejected by validation before normalizeArgs ever runs.
    guid: z
      .string()
      .min(1)
      .optional()
      .describe("Same as instanceGuid, under the name studiorpc_instance_read uses for it."),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "How many levels below Workspace to list when no name or GUID is given. Defaults to 1, the things " +
          "sitting in the world rather than the parts they are made of.",
      ),
  })
  .strict();

/**
 * Accepts `guid`, which is what studiorpc_instance_read calls the same thing. The
 * two tools differ by one word in a long list and testers copy arguments between
 * them; one got `Unrecognized key(s): 'guid'` and had to re-fetch both schemas.
 */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.instanceGuid === undefined && typeof args.guid === "string") {
    const { guid, ...rest } = args;
    return { ...rest, instanceGuid: guid };
  }
  return args;
}

/** How many neighbouring names are worth naming before the list is just the listing. */
const MAX_SUGGESTIONS = 12;

/**
 * Names in a running game are not guessable from the ones in the level: a tester
 * looking for the turret on `PlinthMid` tried `TurretMid` and got an error, because
 * the script had named it `TurretMID`. Offer what is actually there, nearest first.
 */
export function rankNames(names: string[], wanted: string): string[] {
  const lower = wanted.toLowerCase();
  const score = (name: string): number => {
    const candidate = name.toLowerCase();
    if (candidate === lower) return 0;
    if (candidate.startsWith(lower) || lower.startsWith(candidate)) return 1;
    if (candidate.includes(lower) || lower.includes(candidate)) return 2;
    // Shared head or tail: TurretMid and PlinthMid have neither prefix nor substring in
    // common, and the tail is the whole reason the wrong one was guessed.
    let head = 0;
    while (head < candidate.length && head < lower.length && candidate[head] === lower[head]) head++;
    let tail = 0;
    while (
      tail < candidate.length - head &&
      tail < lower.length - head &&
      candidate[candidate.length - 1 - tail] === lower[lower.length - 1 - tail]
    ) {
      tail++;
    }
    return Math.max(head, tail) >= 3 ? 3 : 4;
  };
  return names
    .map((name) => ({ name, rank: score(name) }))
    .filter((entry) => entry.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}

interface WorkspaceListing {
  instances?: { name?: string }[];
}

/**
 * A name that is not in the running world is the answer to "is it gone yet", not a
 * failure to answer. Run 44 used the thrown error as its "the turret was deleted"
 * signal, which works but makes every existence check an error path — and it says
 * nothing about what is there instead.
 */
export async function recover(
  error: unknown,
  args: Record<string, unknown>,
  callRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.includes("is in the running Workspace")) throw error;
  // The transport appends the whole JSON-RPC envelope it sent, which is diagnosis for a
  // failure and noise in an answer.
  const message = (raw.split("\n\nRequest was:")[0] ?? raw).replace(/^Studio RPC error \[[^\]]+\]: /, "");

  const wanted = typeof args.name === "string" ? args.name : undefined;
  let names: string[] = [];
  try {
    const listing = (await callRpc("game.instance.read", {})) as WorkspaceListing;
    names = (listing?.instances ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    // The listing is a courtesy; absence is still the answer without it.
  }

  const suggestions = wanted ? rankNames(names, wanted).slice(0, MAX_SUGGESTIONS) : [];
  return {
    found: false,
    ...(wanted !== undefined ? { name: wanted } : {}),
    ...(typeof args.instanceGuid === "string" ? { instanceGuid: args.instanceGuid } : {}),
    ...(typeof args.guid === "string" ? { instanceGuid: args.guid } : {}),
    note:
      `${message} This is an answer, not a failure — read found: false as "not in the running world", which ` +
      `is what a deleted or never-created instance looks like. Names come from whatever made the instance, ` +
      `so a script's own naming need not match the level's.`,
    ...(suggestions.length > 0 ? { nearestNames: suggestions } : {}),
    ...(names.length > 0 ? { workspaceNames: names.slice(0, 60), workspaceCount: names.length } : {}),
  };
}
