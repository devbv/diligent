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
