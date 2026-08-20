// @summary Naming a live instance: stripping what callers prepend, refusing placeholders, ranking misses.
import { isRecord } from "../camera-response";
export function stripWorkspacePrefix(target: string): string {
  const prefix = /^(game\.)?workspace\./i;
  return prefix.test(target) ? target.replace(prefix, "") : target;
}
export const IDENTIFIER_PARAMS = ["target", "namePattern", "class", "under"] as const;
export function namesNothing(value: unknown): boolean {
  return typeof value === "string" && !/[\p{L}\p{N}]/u.test(value);
}
export function dropPlaceholders(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const key of IDENTIFIER_PARAMS) {
    if (namesNothing(out[key])) delete out[key];
  }
  return out;
}
const MAX_SUGGESTIONS = 12;
const MAX_WORKSPACE_NAMES = 60;
export function rankNames(names: string[], wanted: string): string[] {
  const lower = wanted.toLowerCase();
  const score = (name: string): number => {
    const candidate = name.toLowerCase();
    if (candidate === lower) return 0;
    if (candidate.startsWith(lower) || lower.startsWith(candidate)) return 1;
    if (candidate.includes(lower) || lower.includes(candidate)) return 2;
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
    ...(workspaceNames.length > MAX_WORKSPACE_NAMES ? { workspaceNamesTruncated: true } : {}),
    workspaceNames: workspaceNames.slice(0, MAX_WORKSPACE_NAMES),
  };
}
