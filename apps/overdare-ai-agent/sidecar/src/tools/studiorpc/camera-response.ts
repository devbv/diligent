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
          "floor. Scale distance to the object's own Size. Both ground vectors are null looking straight " +
          "down, where no heading exists. Call locate again after the move and read `normalized`: the " +
          "point must travel the way you meant, and that is the only check that catches a sign error.",
      },
    },
  };
}

/**
 * `level.browse` spells its tree Name/ActorGuid/LuaChildren. Reading it as name/guid/children
 * matched nothing, which made the saved-level fallback below a no-op: outside a play test every
 * locate came back "lookup failed" from the live read, and the editor case — the one this is
 * mostly for — could not locate anything at all. Both spellings are accepted so a browse that
 * ever answers the other way keeps working.
 */
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

/** Any vector-valued property in a response, wherever the reading tool chose to nest it. */
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
  /** `half` is the instance's half-size when it reported one, so visibility can be judged by its
   * bounds: a long sweeper arm crosses the whole screen while its centre is out of frame, and a
   * centre-only verdict called that off-screen. */
  | { found: true; position: Vec3; half?: Vec3; path?: string; matches?: number; otherPaths?: string[] }
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
  // The second sentence is the editor: there is no running world to be absent from, so the live
  // read has not failed to answer — it has no question to answer. Counting it as a failure made
  // every editor locate report "lookup failed" even when the saved level held the object.
  return message.includes("is in the running Workspace") || message.includes("only exists while a play test runs");
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
    // Absent from the running world is an answer; anything else is a question that went
    // unanswered, and the two must not end up in the same list.
    if (!isDefinitelyAbsent(error)) failure = error instanceof Error ? error.message : String(error);
  }
  try {
    // The server answers with { level: [...] }; only the tool's postProcess unwraps that, and this
    // goes to the raw method. Reading `instances` found nothing every time, which is the other half
    // of why an editor locate never answered.
    const browsed = (await callRpc("level.browse", {})) as
      | { instances?: BrowseNode[]; level?: BrowseNode[] }
      | BrowseNode[];
    const roots = Array.isArray(browsed) ? browsed : (browsed?.level ?? browsed?.instances ?? []);
    // The tree stores leaf names, so a dotted path never matches a node. Callers write paths —
    // five camera rounds asked for `Workspace.CamExp.Ramp`, got "in neither", and only found it
    // again by dropping the prefix by hand.
    const node = findNamedNode(roots, name.includes(".") ? (name.split(".").pop() as string) : name);
    const guid = node ? nodeGuid(node) : undefined;
    if (guid !== undefined) {
      // The Studio-side method names it ActorGuid; only the tool of the same name accepts `guid`.
      const read = await callRpc("instance.read", { ActorGuid: guid });
      const position = findCFramePosition(read);
      // Size travels with it so an editor locate can judge visibility by the object's bounds,
      // the same way a play-test locate does. Without it a long wall reads as a single point.
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
