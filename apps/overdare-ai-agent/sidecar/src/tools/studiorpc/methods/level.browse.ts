import { z } from "zod";

export const method = "level.browse";

export const description =
  'Browse the level instance tree. Returns instances with guid, name, class, children, and optional filename (e.g. "WorldManagerScript_1.lua" for Script instances). Optionally filter by classType to return only instances of a specific class. Use maxDepth to limit tree depth (recommended: start with 1).';

export const params = z.object({
  startGuid: z.string().optional().describe("If provided, start browsing from this instance instead of the root."),
  classType: z
    .string()
    .optional()
    .describe('If provided, only return instances whose class matches this value (e.g. "Script", "Part").'),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Maximum depth of the tree to return. 1 = top-level nodes only, 2 = nodes + direct children, etc. 0 or omit for unlimited depth. Recommended to start with 1.",
    ),
});

/** Strip client-only params before sending to Studio RPC (server doesn't support them). */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { startGuid: _s, classType: _c, maxDepth: _d, ...rest } = args;
  return rest;
}

type BrowseNode = Record<string, unknown>;

/**
 * Studio answers with `ActorGuid`/`InstanceType`/`LuaChildren`; older builds used
 * `guid`/`class`/`children`. Both are read, and the key a node arrived with is
 * the key it is rebuilt with, so the shape the caller sees is never rewritten.
 */
function nodeGuid(node: BrowseNode): string | undefined {
  if (typeof node.ActorGuid === "string") return node.ActorGuid;
  return typeof node.guid === "string" ? node.guid : undefined;
}

function nodeClass(node: BrowseNode): string | undefined {
  if (typeof node.InstanceType === "string") return node.InstanceType;
  return typeof node.class === "string" ? node.class : undefined;
}

function nodeChildren(node: BrowseNode): { key: string; list: BrowseNode[] } | undefined {
  if (Array.isArray(node.LuaChildren)) return { key: "LuaChildren", list: node.LuaChildren as BrowseNode[] };
  if (Array.isArray(node.children)) return { key: "children", list: node.children as BrowseNode[] };
  return undefined;
}

function findNode(nodes: BrowseNode[], guid: string): BrowseNode | undefined {
  for (const node of nodes) {
    if (nodeGuid(node) === guid) return node;
    const children = nodeChildren(node);
    if (children) {
      const found = findNode(children.list, guid);
      if (found) return found;
    }
  }
  return undefined;
}

function filterByClass(nodes: BrowseNode[], classType: string): BrowseNode[] {
  const result: BrowseNode[] = [];
  for (const node of nodes) {
    const children = nodeChildren(node);
    const kept = children ? filterByClass(children.list, classType) : [];
    if (nodeClass(node) === classType || kept.length > 0) {
      result.push({ ...node, [children?.key ?? "children"]: kept });
    }
  }
  return result;
}

function truncateDepth(nodes: BrowseNode[], maxDepth: number, depth = 1): BrowseNode[] {
  return nodes.map((node) => {
    const children = nodeChildren(node);
    if (depth >= maxDepth || !children) {
      if (!children) return node;
      const { [children.key]: _dropped, ...rest } = node;
      return rest;
    }
    return { ...node, [children.key]: truncateDepth(children.list, maxDepth, depth + 1) };
  });
}

export function postProcess(result: unknown, args: Record<string, unknown>): unknown {
  // The server returns { level: [...] }; the mock returns a plain array.
  let nodes: BrowseNode[];
  if (Array.isArray(result)) {
    nodes = result as BrowseNode[];
  } else if (
    result &&
    typeof result === "object" &&
    "level" in result &&
    Array.isArray((result as { level: unknown }).level)
  ) {
    nodes = (result as { level: BrowseNode[] }).level;
  } else {
    return result;
  }

  const startGuid = typeof args.startGuid === "string" ? args.startGuid : undefined;
  if (startGuid) {
    const start = findNode(nodes, startGuid);
    if (!start) return [];
    nodes = [start];
  }

  const classType = typeof args.classType === "string" ? args.classType : undefined;
  if (classType) {
    nodes = filterByClass(nodes, classType);
  }

  const maxDepth = typeof args.maxDepth === "number" && args.maxDepth > 0 ? args.maxDepth : undefined;
  if (maxDepth !== undefined) {
    nodes = truncateDepth(nodes, maxDepth);
  }

  return nodes;
}
