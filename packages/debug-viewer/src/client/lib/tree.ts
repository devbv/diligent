import type { SessionEntry } from "./types.js";

export interface ClientSessionTree {
  entries: Map<string, SessionEntry>;
  children: Map<string, string[]>;
  roots: string[];
}

/**
 * Build a tree from session entries (client-side version).
 */
export function buildSessionTree(entries: SessionEntry[]): ClientSessionTree {
  const entryMap = new Map<string, SessionEntry>();
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const entry of entries) {
    entryMap.set(entry.id, entry);
    const parentId = "parentId" in entry ? entry.parentId : undefined;
    if (parentId) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(entry.id);
      children.set(parentId, siblings);
    } else {
      roots.push(entry.id);
    }
  }

  return { entries: entryMap, children, roots };
}

/**
 * Walk the main branch (first child at each fork) to get a linear path.
 */
export function getLinearPath(tree: ClientSessionTree): SessionEntry[] {
  const path: SessionEntry[] = [];

  // Start from the first root and follow first children
  const queue = [...tree.roots];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const entry = tree.entries.get(id);
    if (entry) path.push(entry);

    // Follow first child (main branch)
    const kids = tree.children.get(id);
    if (kids && kids.length > 0) {
      queue.push(kids[0]);
    }
  }

  return path;
}

/**
 * Check if the tree has any forking (multiple children for any node).
 */
export function hasForking(tree: ClientSessionTree): boolean {
  for (const kids of tree.children.values()) {
    if (kids.length > 1) return true;
  }
  return false;
}
