// @summary Shared readers for the camera block Studio returns, and name→position lookup for locate.

import { cameraAxes, type Vec3 } from "./camera-projection";
import { StudioRpcError } from "./rpc";

export type CallRpc = (
  method: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function readVec3(value: unknown): Vec3 | undefined {
  if (!isRecord(value)) return undefined;
  const { X, Y, Z } = value;
  if (typeof X !== "number" || typeof Y !== "number" || typeof Z !== "number") return undefined;
  return { x: X, y: Y, z: Z };
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function roundVec(v: Vec3): Vec3 {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}
export function withCameraAxes(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.camera)) return result;
  const camera = result.camera;
  const cframe = isRecord(camera.CFrame) ? camera.CFrame : undefined;
  const orientation = readVec3(cframe?.Orientation);
  if (!orientation) return result;
  const axes = cameraAxes(orientation);
  return {
    ...result,
    camera: {
      ...camera,
      axes: {
        forward: roundVec(axes.forward),
        right: roundVec(axes.right),
        up: roundVec(axes.up),
        groundForward: axes.groundForward ? roundVec(axes.groundForward) : null,
        groundRight: axes.groundRight ? roundVec(axes.groundRight) : null,
        note:
          "World unit vectors for this view. groundRight/groundForward are the same directions flattened " +
          "onto the horizontal plane, which is what a level edit means by right and forward: newPosition = " +
          "position + groundRight * distance moves a thing rightwards on screen without sinking it into the " +
          "floor. Scale distance to the object's own Size. Both ground vectors are null looking straight " +
          "down, where no heading exists. Call locate again after the move and read `normalized`: the " +
          "point must travel the way you meant, and that is the only check that catches a sign error.",
      },
    },
  };
}
type BrowseNode = {
  guid?: string;
  name?: string;
  children?: BrowseNode[];
  ActorGuid?: string;
  Name?: string;
  LuaChildren?: BrowseNode[];
};

function nodeGuid(node: BrowseNode): string | undefined {
  return typeof node.guid === "string" ? node.guid : typeof node.ActorGuid === "string" ? node.ActorGuid : undefined;
}

function findNamedNode(nodes: BrowseNode[], name: string): BrowseNode | undefined {
  for (const node of nodes) {
    if ((node.name ?? node.Name) === name && nodeGuid(node) !== undefined) return node;
    const children = node.children ?? node.LuaChildren;
    const found = children ? findNamedNode(children, name) : undefined;
    if (found) return found;
  }
  return undefined;
}

function findNodeByPath(nodes: BrowseNode[], path: string): BrowseNode | undefined {
  const parts = path.split(".").filter(Boolean);
  while (/^(game|workspace)$/i.test(parts[0] ?? "")) parts.shift();
  const normalized = parts.join(".").toLowerCase();
  const visit = (entries: BrowseNode[], parent: string): BrowseNode | undefined => {
    for (const node of entries) {
      const name = node.name ?? node.Name;
      if (!name) continue;
      const candidate = parent ? `${parent}.${name}` : name;
      if (candidate.toLowerCase().endsWith(normalized) && nodeGuid(node) !== undefined) return node;
      const found = visit(node.children ?? node.LuaChildren ?? [], candidate);
      if (found) return found;
    }
    return undefined;
  };
  return visit(nodes, "");
}
function findVec3Field(value: unknown, key: string, depth = 0): Vec3 | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  const here = readVec3(value[key]);
  if (here) return here;
  for (const child of Object.values(value)) {
    const found = findVec3Field(child, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}
function findCFramePosition(value: unknown, depth = 0): Vec3 | undefined {
  if (!isRecord(value) || depth > 4) return undefined;
  if (isRecord(value.CFrame)) {
    const position = readVec3(value.CFrame.Position);
    if (position) return position;
  }
  for (const child of Object.values(value)) {
    const found = findCFramePosition(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}
export type LocateResult =
  | { found: true; position: Vec3; half?: Vec3; path?: string; matches?: number; otherPaths?: string[] }
  | { found: false; reason: "absent" }
  | { found: false; reason: "lookupFailed"; detail: string };
function isDefinitelyAbsent(error: unknown): boolean {
  if (error instanceof StudioRpcError && isRecord(error.data)) {
    return error.data.name === "instanceNotFound" || error.data.name === "pieNotRunning";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("is in the running Workspace") || message.includes("only exists while a play test runs");
}

export async function locateInstanceByName(callRpc: CallRpc, name: string): Promise<LocateResult> {
  let failure: string | undefined;
  try {
    const live = await callRpc("game.instance.read", name.includes(".") ? { path: name } : { name });
    const position = findCFramePosition(live);
    if (position) {
      const record = isRecord(live) ? live : {};
      const instance = isRecord(record.instance) ? record.instance : {};
      const size = readVec3(instance.Size);
      return {
        found: true,
        position,
        half: size ? { x: size.x / 2, y: size.y / 2, z: size.z / 2 } : undefined,
        path: typeof instance.path === "string" ? instance.path : undefined,
        matches: typeof record.matches === "number" ? record.matches : undefined,
        otherPaths: Array.isArray(record.otherPaths) ? (record.otherPaths as string[]) : undefined,
      };
    }
  } catch (error) {
    if (!isDefinitelyAbsent(error)) failure = error instanceof Error ? error.message : String(error);
  }
  try {
    const browsed = (await callRpc("level.browse", {})) as
      | { instances?: BrowseNode[]; level?: BrowseNode[] }
      | BrowseNode[];
    const roots = Array.isArray(browsed) ? browsed : (browsed?.level ?? browsed?.instances ?? []);
    const node = name.includes(".") ? findNodeByPath(roots, name) : findNamedNode(roots, name);
    const guid = node ? nodeGuid(node) : undefined;
    if (guid !== undefined) {
      const read = await callRpc("instance.read", { ActorGuid: guid });
      const position = findCFramePosition(read);
      const size = findVec3Field(read, "Size");
      if (position) {
        return {
          found: true,
          position,
          half: size ? { x: size.x / 2, y: size.y / 2, z: size.z / 2 } : undefined,
        };
      }
    }
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }
  if (failure !== undefined) return { found: false, reason: "lookupFailed", detail: failure };
  return { found: false, reason: "absent" };
}
export async function listRunningInstanceNames(callRpc: CallRpc): Promise<string[]> {
  try {
    const listing = (await callRpc("game.instance.read", {})) as { instances?: { name?: unknown }[] };
    return (listing?.instances ?? [])
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}
