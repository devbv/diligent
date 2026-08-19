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

/**
 * Studio writes the tree as Name/ActorGuid/InstanceType/LuaChildren. Reading it as guid/class/
 * children matched nothing, so every filter below silently returned an empty list: four camera
 * rounds browsed from the Workspace GUID, got `[]`, and had to fall back to a full-tree read.
 * Both spellings are accepted so a server that ever answers the other way keeps working.
 */
type BrowseNode = {
  guid?: string;
  class?: string;
  children?: BrowseNode[];
  ActorGuid?: string;
  InstanceType?: string;
  LuaChildren?: BrowseNode[];
};

function nodeGuid(node: BrowseNode): string | undefined {
  return node.guid ?? node.ActorGuid;
}

function nodeClass(node: BrowseNode): string | undefined {
  return node.class ?? node.InstanceType;
}

function nodeChildren(node: BrowseNode): BrowseNode[] | undefined {
  return node.children ?? node.LuaChildren;
}

/** Rewrites a node's children in whichever key it arrived under, so a filter cannot lose them. */
function withChildren(node: BrowseNode, children: BrowseNode[] | undefined): BrowseNode {
  const { children: _c, LuaChildren: _l, ...rest } = node;
  if (children === undefined) return rest;
  return node.children !== undefined || node.LuaChildren === undefined
    ? { ...rest, children }
    : { ...rest, LuaChildren: children };
}

function findNode(nodes: BrowseNode[], guid: string): BrowseNode | undefined {
  for (const node of nodes) {
    if (nodeGuid(node) === guid) return node;
    const children = nodeChildren(node);
    if (children) {
      const found = findNode(children, guid);
      if (found) return found;
    }
  }
  return undefined;
}

function filterByClass(nodes: BrowseNode[], classType: string): BrowseNode[] {
  const result: BrowseNode[] = [];
  for (const node of nodes) {
    const own = nodeChildren(node);
    const children = own ? filterByClass(own, classType) : [];
    if (nodeClass(node) === classType || children.length > 0) {
      result.push(withChildren(node, children));
    }
  }
  return result;
}

function truncateDepth(nodes: BrowseNode[], maxDepth: number, depth = 1): BrowseNode[] {
  return nodes.map((node) => {
    const children = nodeChildren(node);
    if (depth >= maxDepth || !children) return withChildren(node, undefined);
    return withChildren(node, truncateDepth(children, maxDepth, depth + 1));
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
