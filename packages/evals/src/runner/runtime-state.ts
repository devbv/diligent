// @summary Classifies and diffs explicit runtime-state trees for eval mutation policy enforcement

import type {
  RuntimeStateCategory,
  RuntimeStateChange,
  RuntimeStateEntry,
  RuntimeStateEvidence,
  RuntimeStatePolicy,
  RuntimeWorldSnapshot,
} from "../runtime-task";
import type { EvalFailure } from "../task";

export function captureRuntimeState(
  initial: RuntimeWorldSnapshot,
  final: RuntimeWorldSnapshot,
  stateRoots: readonly string[],
): RuntimeStateEvidence {
  const before = classifyRuntimeState(initial, stateRoots);
  const after = classifyRuntimeState(final, stateRoots);
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const diff: RuntimeStateChange[] = [];
  for (const path of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    const left = beforeByPath.get(path);
    const right = afterByPath.get(path);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    diff.push({
      path,
      category: (right ?? left)!.category,
      change: left ? (right ? "modified" : "removed") : "added",
    });
  }
  return { initial: before, final: after, diff: diff.sort(comparePath) };
}

export function classifyRuntimeState(
  snapshot: RuntimeWorldSnapshot,
  stateRoots: readonly string[],
): RuntimeStateEntry[] {
  const roots = [...new Set(stateRoots.map(normalizeRoot))].sort((a, b) => b.length - a.length);
  return snapshot.entries
    .flatMap((entry): RuntimeStateEntry[] => {
      const root = roots.find((candidate) => entry.path === candidate || entry.path.startsWith(`${candidate}/`));
      if (!root) return [];
      const relative = entry.path.slice(root.length).replace(/^\//, "");
      return [{ ...entry, category: classifyRelativeStatePath(relative) }];
    })
    .sort(comparePath);
}

export function projectSnapshotWithoutRuntimeState(
  snapshot: RuntimeWorldSnapshot,
  stateRoots: readonly string[],
): RuntimeWorldSnapshot {
  const statePaths = new Set(classifyRuntimeState(snapshot, stateRoots).map((entry) => entry.path));
  return { entries: snapshot.entries.filter((entry) => !statePaths.has(entry.path)) };
}

export function checkRuntimeStatePolicy(
  evidence: RuntimeStateEvidence,
  policy: RuntimeStatePolicy,
  completed: boolean,
): EvalFailure[] {
  const changed = new Set(evidence.diff.map((entry) => entry.category));
  const allowed = new Set(policy.allowedMutations);
  const failures: EvalFailure[] = [];
  const forbidden = [...changed].filter((category) => !allowed.has(category)).sort();
  if (forbidden.length > 0) {
    failures.push({
      dimension: "runtime_policy",
      category: "runtime_contract",
      code: "runtime_contract.undeclared_state_mutation",
      message: `Undeclared runtime-state mutations: ${forbidden.join(", ")}.`,
    });
  }
  if (completed) {
    const missing = [...new Set(policy.requiredMutations ?? [])].filter((category) => !changed.has(category)).sort();
    if (missing.length > 0) {
      failures.push({
        dimension: "runtime_policy",
        category: "runtime_contract",
        code: "runtime_contract.required_state_mutation_missing",
        message: `Required runtime-state mutations did not occur: ${missing.join(", ")}.`,
      });
    }
  }
  return failures;
}

function classifyRelativeStatePath(path: string): RuntimeStateCategory {
  if (path === "" || path === ".gitignore") return "infrastructure";
  const [top, second] = path.split("/");
  if (["sessions", "images", "knowledge", "skills"].includes(top!) && second === undefined) return "infrastructure";
  if (top === "sessions" && second === "blobs") return "image_sidecars";
  if (top === "sessions") return "sessions";
  if (top === "images") return "image_sidecars";
  if (top === "knowledge") return "knowledge";
  if (top === "skills") return "skills";
  return "other";
}

function normalizeRoot(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/$/, "");
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}
