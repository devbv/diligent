// @summary Declares the Studio RPC method for reading an instance as the running game has it.
import { z } from "zod";
import { isRecord } from "../camera-response";

export const method = "game.instance.read";

export const description =
  "Read an instance as the running game currently has it, by its runtime name. " +
  "This is the live counterpart to studiorpc_instance_read, which reads the level as authored and so cannot " +
  "see anything a script changed after play started. When a script claims to have opened a door, dimmed a " +
  "light, or disabled a trigger, this is what tells you whether it actually did — CanCollide, CanTouch, " +
  "Transparency, Size and the current CFrame come from the live instance, not the saved level. " +
  "Size is how big the part actually is, which is what tells you how close counts as reaching it — though " +
  "naming the thing as studiorpc_game_character_move_to's target already measures to its surface, so you " +
  "seldom have to do that arithmetic yourself. Shape says whether that " +
  "size describes a Block, a Ball or a Cylinder — a 400x400x4 part is a disc or a square slab depending on " +
  "it, and a screenshot will not settle which. " +
  "Reach for it the moment the game's own log and what you can see disagree: a part can be made " +
  "see-through without being made passable, and only this shows the difference. " +
  "Call it with no arguments to list what sits directly in the running Workspace with its name, path, class, " +
  "position, size and colour — that is the live counterpart to studiorpc_level_browse, and the way to find out " +
  "what a name is before asking about it. It stops at the top level on purpose, because a character's rig is " +
  "dozens of instances and would bury the handful you came for; raise maxDepth when you need inside " +
  "something, and the reply says how much was left out. " +
  "Pair either with fields to keep only the properties you are actually reading. " +
  "This tool reads one thing. When you want several — or an instance *and* the character or the UI — that " +
  "is studiorpc_game_observe, whose `instances` section takes this tool's arguments plus a list of names to " +
  "read at once. Two calls to this in a row is the shape to avoid: measured across 68 runs, 221 such calls " +
  "were repeats inside one look at the world and 95% could have been asked together. " +
  "`under` narrows any of it to one subtree by path, and giving a `target` together with maxDepth is the " +
  "same thing said the other way round: it lists that branch instead of reading the one instance, with the " +
  "depth counted from the branch rather than from Workspace. Either is how you ask for one tray's four pots " +
  "without receiving all sixty-four. " +
  "In a world of any size, reach for namePattern and class before maxDepth: they search the whole world " +
  "regardless of depth and answer with just the matches. Measured on a fixture whose 64 pots sit four levels " +
  "down, the depth-4 listing that reaches them is 126 KB against 5.7 KB for the top level, while a filtered " +
  "search for those same pots is a fraction of either. " +
  "Every instance, listed or read, carries its `path` — the dot-separated route from Workspace down, which is " +
  "the only thing that identifies it. A name is unique only among siblings, so ask by path whenever the world " +
  "reuses names: reading `Pot3` in a world with sixteen of them answers about one of them, says so with " +
  "`matches` and `otherPaths`, and the one it picked need not be yours. " +
  "`world` says which copy of the world answered. The input tools drive a client, so that is the copy you " +
  "read, and the game's rules and collision are judged on the authority copy — when you are asking whether " +
  "something was hit where it was drawn, those are two different questions and this is the one that says " +
  "so. " +
  "A target that is not in the running world answers `found: false` with the names that are, rather than " +
  "raising — so this is also how you check that something was deleted, and how you recover from a name " +
  "that a script chose differently from the level.";

/**
 * Paths are rooted *below* Workspace — `Glasshouse.RackA.Pot1`, never `Workspace.Glasshouse...` —
 * but every description calls a path "the route from Workspace down", and gpt-5.6-terra read that
 * as an instruction to write the word. `Workspace.PressurePump` then matched nothing, in a world
 * whose only pump is called PressurePump. The prefix is the caller agreeing with the description,
 * so it is accepted rather than corrected.
 */
export function stripWorkspacePrefix(target: string): string {
  const prefix = /^(game\.)?workspace\./i;
  return prefix.test(target) ? target.replace(prefix, "") : target;
}

/** Parameters whose value is an instance name, class or path — the ones a placeholder ruins. */
export const IDENTIFIER_PARAMS = ["target", "namePattern", "class", "under"] as const;

/**
 * A caller that has no value for an optional parameter writes one that means "nothing" rather than
 * leaving it out. Empty strings are dropped before validation; this is the same gesture spelled
 * with punctuation — gpt-5.6-terra sent `namePattern: "__none__"` on one run and `"."` on the next.
 *
 * `"."` is the one that does damage quietly. namePattern matches the *path* as well as the name,
 * every nested path contains a dot, so it turned a maxDepth-1 listing into an 80-instance search of
 * the whole world and answered plausibly. No instance name, class or path is punctuation alone, so
 * a value with no letter or digit in it names nothing and is read as the parameter being absent.
 */
export function namesNothing(value: unknown): boolean {
  return typeof value === "string" && !/[\p{L}\p{N}]/u.test(value);
}

/** Drop the identifier parameters that name nothing, so a placeholder does not filter anything. */
export function dropPlaceholders(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const key of IDENTIFIER_PARAMS) {
    if (namesNothing(out[key])) delete out[key];
  }
  return out;
}

/**
 * Studio's game.instance.read still takes `name` and `path` separately. Which one `target` meant
 * is decided here, by the same rule the batch read uses: a dot means a path.
 */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { target, ...rest } = dropPlaceholders(args);
  if (typeof target !== "string") return rest;
  const wanted = stripWorkspacePrefix(target);
  return wanted.includes(".") ? { ...rest, path: wanted } : { ...rest, name: wanted };
}

export const params = z
  .object({
    target: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Which instance: a runtime name ("Gate"), or the dot-separated route every listed instance reports ' +
          '("Glasshouse.RackA.Tray2.Pot3"). The same spelling studiorpc_game_character_move_to and ' +
          "studiorpc_game_observe take. Names are unique only among siblings, so when more than one instance " +
          "has this name the answer says which one it picked and what the others are — the path is how you " +
          "ask for a particular one. Anything containing a dot is tried as a path first and as a name second, " +
          "so an instance whose own name has a dot in it is still reachable.",
      ),
    namePattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Find every instance whose name *or path* contains this text, anywhere in the world and at any depth, " +
          "case-insensitively. Plain text, not a regular expression. This is the cheap way to locate things " +
          "in a deep world — it ignores maxDepth and returns only what matched. Because it also matches the " +
          'path, "Tray2.Pot" picks out one tray\'s pots in a world with sixteen instances named Pot1.',
      ),
    class: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Find every instance of this class, at any depth (for example "Part" or "Model"). Combines with ' +
          "namePattern, and like it, ignores maxDepth.",
      ),
    under: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Search only inside this instance, by path (for example "Glasshouse.RackB"). Combines with ' +
          "namePattern and class, and is the cheap way to ask a question about one part of the world — " +
          '"how many pots in RackB are brown" costs the whole world without it.',
      ),
    fields: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Which per-instance fields to keep in a listing, for example ["Color"] or ["CFrame","Transparency"]. ' +
          "name, path and class are always kept. Use it when you are polling one property across many " +
          "instances: the same 64-instance listing is about 98 KB whole and a few KB projected.",
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "How many levels to list. Defaults to 1, the things sitting in the world rather than the parts they " +
          "are made of. Counted from Workspace on its own; counted from the branch when given with `under`, " +
          "`path` or `name` — and giving it with a path or name lists that branch rather than reading it.",
      ),
  })
  .strict()
  // `target` names one instance; `namePattern` and `class` search the whole world for many. Both
  // reach Studio, which answers the name and drops the search in silence — a play test asked for
  // `target: "Turret"` beside `namePattern: "Turret"` and was told nothing is called Turret, in a
  // world holding TurretLeft, TurretMid and TurretRight. Refusing costs a turn; answering the
  // wrong one of two questions costs the belief that the thing is not there.
  .refine((value) => value.target === undefined || (value.namePattern === undefined && value.class === undefined), {
    message:
      "target names one instance, and namePattern/class search for many — they are two questions, and " +
      "Studio answers only the first. Ask for the one you want: drop target to search, drop the search to " +
      "read that instance, or use `under` to search inside a particular subtree.",
  });

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

/**
 * Asking for one absent name answers with what is there instead, ranked. Asking for twenty
 * and getting three back as `notFound` used to answer with nothing of the kind — so a single
 * typo made batching worse than the one-at-a-time calls it replaces, which is the fastest way
 * to lose a saving that only exists if callers actually take it. Studio ships the running
 * world's distinct names at every depth alongside the misses, and the ranking is the same
 * function the single-name path uses rather than a second copy of the idea.
 *
 * Depth is the part that had to be learned: the first version shipped only the top level, and
 * the gate caught it immediately — Glasshouse keeps `Bed` three levels down, so a typo of the
 * one name a tester types most often got no suggestion at all, in exactly the kind of world
 * where suggestions are worth having.
 */
export function postProcess(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const workspaceNames = Array.isArray(result.workspaceNames)
    ? result.workspaceNames.filter((name): name is string => typeof name === "string")
    : [];
  if (!Array.isArray(result.instances) || workspaceNames.length === 0) return result;
  return {
    ...result,
    instances: result.instances.map((entry) => {
      if (!isRecord(entry) || entry.status !== "notFound" || typeof entry.query !== "string") return entry;
      const nearest = rankNames(workspaceNames, entry.query).slice(0, MAX_SUGGESTIONS);
      return nearest.length > 0 ? { ...entry, nearestNames: nearest } : entry;
    }),
    // Trimming here and saying nothing would be the silent truncation this harness keeps
    // catching in other people's code. Studio's own count stays beside it either way.
    ...(workspaceNames.length > MAX_WORKSPACE_NAMES ? { workspaceNamesTruncated: true } : {}),
    // The full list is raw material for the ranking above, not an answer. Emitting the same
    // 60 the single-name path emits keeps one typo from filling the reply with a namespace,
    // and workspaceNameCount from Studio still says how many there really are.
    workspaceNames: workspaceNames.slice(0, MAX_WORKSPACE_NAMES),
  };
}

/** How many of the running world's names are worth showing beside a miss. */
const MAX_WORKSPACE_NAMES = 60;

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

  const wanted = typeof args.target === "string" ? args.target : undefined;
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
    note:
      `${message} This is an answer, not a failure — read found: false as "not in the running world", which ` +
      `is what a deleted or never-created instance looks like. Names come from whatever made the instance, ` +
      `so a script's own naming need not match the level's.`,
    ...(suggestions.length > 0 ? { nearestNames: suggestions } : {}),
    ...(names.length > 0 ? { workspaceNames: names.slice(0, 60), workspaceCount: names.length } : {}),
  };
}
