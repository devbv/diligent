// @summary Defines OVERDARE procedural dummy JSON runtime types.

export interface Vector3Json {
  X: number;
  Y: number;
  Z: number;
}

export interface Color3Json {
  R: number;
  G: number;
  B: number;
}

export interface CFrameJson {
  Position: Vector3Json;
  Orientation: Vector3Json;
}

export interface ProceduralParameters {
  Size: Vector3Json;
  Attributes?: Record<string, unknown>;
}

export interface ProceduralGenerationInput {
  scriptSource: string;
  parameters: ProceduralParameters;
  scriptName?: string;
}

export interface ProceduralDummyJson {
  version: 1;
  kind: "overdare.procedural-dummy-json";
  scriptName: string;
  parameters: ProceduralParameters;
  children: ProceduralGeneratedNode[];
}

export interface ProceduralGeneratedNode {
  class: string;
  name: string;
  localId: string;
  properties: Record<string, unknown>;
  children?: ProceduralGeneratedNode[];
}

export interface ProceduralModelProperties {
  WorldPivot?: CFrameJson;
}

export interface ProceduralPartProperties {
  Shape?: "Block" | "Ball" | "Cylinder";
  CFrame?: CFrameJson;
  Size?: Vector3Json;
  Anchored?: boolean;
  CanCollide?: boolean;
  CanQuery?: boolean;
  CanTouch?: boolean;
  CastShadow?: boolean;
  CollisionGroup?: string;
  Color?: Color3Json;
  Locked?: boolean;
  Mass?: number;
  Massless?: boolean;
  Material?: string;
  MaterialVariant?: string;
  Reflectance?: number;
  RootPriority?: number;
  Transparency?: number;
}

/**
 * A node as serialized by the Luau runner. Injected (pre-existing scene) nodes
 * carry a `guid`; freshly-built nodes carry an execution-local `localId`.
 * Exactly one identity is present. Class-specific properties are
 * validated at the Studio RPC apply boundary.
 */
export interface ProceduralSerializedNode {
  class: string;
  name: string;
  guid?: string;
  localId?: string;
  properties?: Record<string, unknown>;
  children?: ProceduralSerializedNode[];
}

/** A scene subtree fed into the Luau runner so transform scripts can read it. */
export interface ProceduralSceneNode {
  class: string;
  name: string;
  guid: string;
  properties: Record<string, unknown>;
  children: ProceduralSceneNode[];
}

/** An existing or execution-local generated instance used as an operation parent. */
export type ProceduralInstanceRef = { kind: "existing"; guid: string } | { kind: "generated"; localId: string };

/** A fresh node to create after its symbolic parent has resolved. */
export interface ProceduralAddOp {
  kind: "add";
  localId: string;
  parent: ProceduralInstanceRef;
  class: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface ProceduralMoveOp {
  kind: "move";
  guid: string;
  parent: ProceduralInstanceRef;
}

/**
 * A single flat scene mutation derived by diffing the injected snapshot
 * against the runner's final tree. Hierarchy is expressed through symbolic
 * parent references rather than recursive add subtrees.
 */
export type ProceduralOp =
  | ProceduralAddOp
  | { kind: "update"; guid: string; class: string; name?: string; properties: Record<string, unknown> }
  | ProceduralMoveOp
  | { kind: "delete"; guid: string; depth: number };

export interface RunProceduralScriptInput {
  scriptSource: string;
  parameters: ProceduralParameters;
  scriptName?: string;
  /** Injected scene subtree (its root maps to `targetGuid`) for transform scripts. */
  scene?: ProceduralSceneNode;
  /** GUID that top-level fresh nodes attach to; also the injected scene root's GUID. */
  targetGuid?: string;
}

export interface RunProceduralScriptResult {
  scriptName: string;
  ops: ProceduralOp[];
  nodeCount: number;
}
