// @summary Sends the Studio v2 instance RPCs and unwraps their responses.

import { call, RPC_INSTANCE_NOT_FOUND, StudioRpcError } from "../../rpc";
import { isRecord, type OvdrjmNode } from "../ovdrjm-utils";
import { checkResult } from "./result";
import { tagObjectTypes } from "./wire";

/** `instance.read` depth: 0 = the instance alone, N = N levels below it, -1 = the whole subtree. */
export const DEPTH_SELF = 0;
export const DEPTH_SUBTREE = -1;

/** Mirrors the level root's node shape; Studio never sends the root itself. */
const LEVEL_ROOT_INSTANCE_TYPE = "DataModel";

/** Warnings raised by the most recent write; the tools append them to their suggestions. */
let lastWarnings: string[] = [];

export function takeWarnings(): string[] {
  const warnings = lastWarnings;
  lastWarnings = [];
  return warnings;
}

/** Members of `params` are PascalCase; the envelope and method names stay snake_case. */
export async function callInstanceRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const result = await call(method, tagObjectTypes(params) as Record<string, unknown>);
  lastWarnings = lastWarnings.concat(checkResult(method, result).warnings);
  return result;
}

/**
 * Flushes Studio's editor state to .umap/.ovdrjm. The tools that stay on v1 read
 * those files, so a v2 write that skips this is overwritten by the next one.
 */
export async function saveLevelFile(): Promise<void> {
  await call("level.save.file", {});
}

/**
 * Answers undefined for a guid Studio does not know, the same as the file backend's
 * lookup miss. Every caller already branches on that; letting the RPC error through
 * instead would skip those branches and surface the raw JSON-RPC envelope.
 */
export async function readInstanceNode(actorGuid: string, depth: number): Promise<OvdrjmNode | undefined> {
  let result: unknown;
  try {
    result = await callInstanceRpc("instance.read", { ActorGuid: actorGuid, Depth: depth });
  } catch (error) {
    if (error instanceof StudioRpcError && error.code === RPC_INSTANCE_NOT_FOUND) return undefined;
    throw error;
  }
  const instance = isRecord(result) ? (result as { instance?: unknown }).instance : undefined;
  return isRecord(instance) ? (instance as OvdrjmNode) : undefined;
}

/**
 * There is no ActorGuid that names the level root — `instance.read` answers
 * -32004 for an empty guid and for every sentinel. `level.browse` lists the
 * top-level services instead, but only carries guid/name/class, so each service
 * is re-read at full depth to get the properties callers rely on (Mobility,
 * Source). The root node is assembled locally and carries no ActorGuid, so a
 * guid lookup can never resolve to it.
 */
async function browseTopLevel(): Promise<OvdrjmNode[]> {
  const browsed = await call("level.browse", {});
  const level = isRecord(browsed) ? (browsed as { level?: unknown }).level : undefined;
  if (!Array.isArray(level)) throw new Error("level.browse returned no level list.");
  return level.filter(isRecord) as OvdrjmNode[];
}

function asRoot(children: OvdrjmNode[]): OvdrjmNode {
  if (children.length === 0) throw new Error("level.browse listed no top-level instances.");
  return { InstanceType: LEVEL_ROOT_INSTANCE_TYPE, Name: "Game", LuaChildren: children };
}

/**
 * Hierarchy only, in one round trip. `level.browse` carries ActorGuid, Name,
 * InstanceType and LuaChildren — enough to resolve a guid, read its class and walk
 * the parent graph. Callers that need property values want `readLevelRoot`.
 */
export async function readLevelTreeLite(): Promise<OvdrjmNode> {
  return asRoot(await browseTopLevel());
}

/**
 * The whole tree with every property, at the cost of one round trip per top-level
 * instance. `level.browse` alone omits the values that Mobility policy, property
 * diffing and script search read, so each service is re-read at full depth.
 */
export async function readLevelRoot(): Promise<OvdrjmNode> {
  const children: OvdrjmNode[] = [];
  for (const entry of await browseTopLevel()) {
    const guid = (entry as { ActorGuid?: unknown }).ActorGuid;
    if (typeof guid !== "string" || guid === "") continue;
    const node = await readInstanceNode(guid, DEPTH_SUBTREE);
    if (node) children.push(node);
  }
  return asRoot(children);
}

/** `instance.create` answers with one GUID per requested instance, in request order. */
export function createdActorGuids(result: unknown): string[] {
  const guids = isRecord(result) ? (result as { ActorGuids?: unknown }).ActorGuids : undefined;
  if (!Array.isArray(guids)) return [];
  return guids.map((guid) => (typeof guid === "string" ? guid : ""));
}

export function rpcOutput(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
