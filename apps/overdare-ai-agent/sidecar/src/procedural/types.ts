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
  generationId: string;
  scriptName: string;
  parameters: ProceduralParameters;
  children: ProceduralGeneratedNode[];
}

export interface ProceduralGeneratedNode {
  class: "Model" | "Part";
  name: string;
  properties: ProceduralModelProperties | ProceduralPartProperties;
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
 * carry a `guid`; freshly-built nodes do not. `properties` is left untyped here
 * because injected nodes carry only the diff whitelist while fresh nodes carry
 * full class-specific properties.
 */
export interface ProceduralSerializedNode {
  class: string;
  name: string;
  guid?: string;
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

/** A fresh subtree to create; applied parent-first using live returned GUIDs. */
export interface ProceduralAddNode {
  class: string;
  name: string;
  properties: Record<string, unknown>;
  children?: ProceduralAddNode[];
}

/**
 * A single scene mutation derived by diffing the injected snapshot against the
 * runner's final tree. `add.parentGuid` is undefined for top-level nodes (they
 * attach to the run's target GUID).
 */
export type ProceduralOp =
  | { kind: "add"; parentGuid?: string; node: ProceduralAddNode }
  | { kind: "update"; guid: string; class: string; name?: string; properties: Record<string, unknown> }
  | { kind: "delete"; guid: string; depth: number };

export interface RunProceduralScriptInput {
  scriptSource: string;
  parameters: ProceduralParameters;
  scriptName?: string;
  /** Injected scene subtree (its root maps to `targetGuid`) for transform scripts. */
  scene?: ProceduralSceneNode;
  /** GUID that top-level fresh nodes attach to; also the injected scene root's GUID. */
  targetGuid?: string;
  /** One-shot mode: auto-fill a missing `-- generationId:` comment instead of erroring. */
  autoGenerationId?: boolean;
}

export interface RunProceduralScriptResult {
  generationId: string;
  scriptName: string;
  ops: ProceduralOp[];
  nodeCount: number;
}
