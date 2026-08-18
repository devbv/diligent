// @summary Shared readers for the camera block Studio returns, and name→position lookup for locate.

import { cameraAxes, type Vec3 } from "./camera-projection";

export type CallRpc = (
  method: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Studio writes vectors with capital XYZ; everything downstream of here uses lowercase. */
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

/**
 * Adds world-space axes to a response's camera block. Whoever reads the camera is usually about
 * to answer a question phrased against the screen — "the pillar on the left", "move it right" —
 * and the conversion needs a direction, not just a position. Deriving it from Orientation by hand
 * is where the sign of `right` gets flipped, and a scene symmetric about the view axis gives back
 * no evidence that it did.
 */
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
          "floor. Scale distance to the object's own Size, not to visibleExtentAtFocus — that number " +
          "describes wherever the centre ray happened to land and reads in the tens of thousands when it " +
          "grazes distant ground. Both ground vectors are null looking straight down, where no heading " +
          "exists. Call locate again after the move: the pixel must travel the way you meant, and that is " +
          "the only check that catches a sign error.",
      },
    },
  };
}

type BrowseNode = { guid?: string; name?: string; class?: string; children?: BrowseNode[] };

function findNamedNode(nodes: BrowseNode[], name: string): BrowseNode | undefined {
  for (const node of nodes) {
    if (node.name === name && typeof node.guid === "string") return node;
    const found = node.children ? findNamedNode(node.children, name) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Any CFrame.Position in a response, wherever the reading tool chose to nest it. */
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

/**
 * Where a named instance is, asking the running game first and the saved level second.
 *
 * The order matters and is not a preference: during a play test a script may have moved the thing,
 * and the saved level would answer where it was authored. Outside a play test the running world
 * does not exist at all, which is the case this is mostly for — placing and checking geometry in
 * the editor viewport.
 */
export type LocateResult =
  | { found: true; position: Vec3; path?: string; matches?: number; otherPaths?: string[] }
  /** Both sources answered, and the name is in neither. */
  | { found: false; reason: "absent" }
  /** A lookup errored, so nothing is known about the name — which is not the same claim. */
  | { found: false; reason: "lookupFailed"; detail: string };

/**
 * `game.instance.read` reports an absent name by *throwing* -32150. The tool of the same name
 * catches that in its `recover` and turns it into `found: false` plus what is there instead —
 * but this goes to the raw method, so it lands on the throw. The same sentence the tool
 * matches on is the discriminator here, and getting this wrong in either direction is a real
 * cost: treating every error as absence is what told run 56 that two live husks were in
 * neither the running game nor the saved level, seconds after it had read one of them
 * directly, and it spent about four extra calls per kill working around that sentence.
 */
function isDefinitelyAbsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("is in the running Workspace");
}

export async function locateInstanceByName(callRpc: CallRpc, name: string): Promise<LocateResult> {
  let failure: string | undefined;
  try {
    // A dotted name is a path. Names are unique only among siblings, and a world that reuses
    // them — sixteen instances called Pot3 — answers a bare name with whichever the search
    // reached first: run 71 asked for two pots and was silently given a different tray's pair,
    // then projected them to pixels that were off screen with nothing saying why.
    const live = await callRpc("game.instance.read", name.includes(".") ? { path: name } : { name });
    const position = findCFramePosition(live);
    if (position) {
      const record = isRecord(live) ? live : {};
      const instance = isRecord(record.instance) ? record.instance : {};
      return {
        found: true,
        position,
        path: typeof instance.path === "string" ? instance.path : undefined,
        matches: typeof record.matches === "number" ? record.matches : undefined,
        otherPaths: Array.isArray(record.otherPaths) ? (record.otherPaths as string[]) : undefined,
      };
    }
  } catch (error) {
    // Absent from the running world is an answer; anything else is a question that went
    // unanswered, and the two must not end up in the same list.
    if (!isDefinitelyAbsent(error)) failure = error instanceof Error ? error.message : String(error);
  }
  try {
    const browsed = (await callRpc("level.browse", {})) as { instances?: BrowseNode[] } | BrowseNode[];
    const roots = Array.isArray(browsed) ? browsed : (browsed?.instances ?? []);
    const node = findNamedNode(roots, name);
    if (node?.guid) {
      const read = await callRpc("instance.read", { guid: node.guid, recursive: false });
      const position = findCFramePosition(read);
      if (position) return { found: true, position };
    }
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }
  if (failure !== undefined) return { found: false, reason: "lookupFailed", detail: failure };
  return { found: false, reason: "absent" };
}

/** What the running Workspace holds, for telling a caller what it could have named instead. */
export async function listRunningInstanceNames(callRpc: CallRpc): Promise<string[]> {
  try {
    const listing = (await callRpc("game.instance.read", {})) as { instances?: { name?: unknown }[] };
    return (listing?.instances ?? [])
      .map((entry) => entry?.name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    // A courtesy. Absence is still the answer without it.
    return [];
  }
}
