// @summary Naming a live instance: stripping what callers prepend, refusing placeholders, ranking misses.
import { isRecord } from "../camera-response";

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

/** How many neighbouring names are worth naming before the list is just the listing. */
const MAX_SUGGESTIONS = 12;

/** How many of the running world's names are worth showing beside a miss. */
const MAX_WORKSPACE_NAMES = 60;

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
