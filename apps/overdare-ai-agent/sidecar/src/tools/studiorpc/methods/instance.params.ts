// @summary Defines shared instance property schemas and class enums for Studio RPC tools.
import { z } from "zod";

/**
 * Studio names the type inside the value — `{"ObjectType":"CFrame", "Position":{...}}` — in the
 * .ovdrjm and over the RPC alike. The file parser also accepts a value without it, inferring the
 * type from the property, but instance.create and instance.update do not: an untagged CFrame comes
 * back as "Property CFrame expects LuaCFrame ... but received Position : Object".
 *
 * So the name is declared here and defaulted in, once per type. Callers still write the bare shape
 * and every path downstream sends what Studio writes itself. The name is the rejection's Lua type
 * without the prefix — LuaUDim2 is UDim2, LuaFont is Font (the property is FontFace, the type is
 * not). Measured against Studio 2026-08-27.
 */
function tagged<const N extends string, S extends z.ZodRawShape>(name: N, shape: S) {
  return z.object({ ObjectType: z.literal(name).default(name), ...shape });
}

const vec3 = tagged("Vector3", { X: z.number(), Y: z.number(), Z: z.number() });
/** A Vector2 and a UDim2 are both `{X, Y}`; only the member type separates them. */
const vec2 = tagged("Vector2", { X: z.number(), Y: z.number() });
const udim = tagged("UDim", { Scale: z.number(), Offset: z.number() });
const colorChannel = z.number().int().min(0).max(255);
const rgb = tagged("Color3", { R: colorChannel, G: colorChannel, B: colorChannel });
const udim2 = tagged("UDim2", { X: udim, Y: udim });
const cframe = tagged("CFrame", { Position: vec3, Orientation: vec3 });
/** Ranges come from the engine's ClampMin/ClampMax on FLuaPhysicalProperties. */
const physicalProperties = tagged("PhysicalProperties", {
  Density: z.number().min(0).max(1000),
  Elasticity: z.number().min(0).max(1),
  Friction: z.number().min(0).max(2),
});
/** Studio's BrickColor is a palette entry, not a free colour. Note the lowercase channel keys. */
const brickColor = tagged("BrickColor", {
  Name: z.string(),
  Number: z.number().int(),
  r: colorChannel,
  g: colorChannel,
  b: colorChannel,
});
/** Studio serialises Rect flat — four scalars, not two nested Vector2s. It clamps out-of-range values but not inverted ones. */
const rect = tagged("Rect", {
  MinX: z.number(),
  MinY: z.number(),
  MaxX: z.number(),
  MaxY: z.number(),
}).refine((r) => r.MinX <= r.MaxX && r.MinY <= r.MaxY, {
  message: "SliceCenter needs MinX <= MaxX and MinY <= MaxY; an inverted rectangle has no centre region.",
});

const normalIdEnum = z.enum(["Right", "Top", "Back", "Left", "Bottom", "Front"]);
const traceChannelEnum = z.enum([
  "L_ECC_WorldStatic",
  "L_ECC_WorldDynamic",
  "L_ECC_Pawn",
  "L_ECC_Visibility",
  "L_ECC_Camera",
  "L_ECC_PhysicsBody",
  "L_ECC_Vehicle",
  "L_ECC_Destructible",
  "L_ECC_EngineTraceChannel1",
  "L_ECC_EngineTraceChannel2",
  "L_ECC_EngineTraceChannel3",
  "L_ECC_EngineTraceChannel4",
  "L_ECC_WeaponTrace",
  "L_ECC_InteractionTrace",
  "L_ECC_GameTraceChannel1",
  "L_ECC_GameTraceChannel2",
  "L_ECC_GameTraceChannel3",
  "L_ECC_GameTraceChannel4",
  "L_ECC_GameTraceChannel5",
  "L_ECC_GameTraceChannel6",
  "L_ECC_GameTraceChannel7",
  "L_ECC_GameTraceChannel8",
  "L_ECC_GameTraceChannel9",
  "L_ECC_GameTraceChannel10",
  "L_ECC_GameTraceChannel11",
  "L_ECC_GameTraceChannel12",
  "L_ECC_GameTraceChannel13",
  "L_ECC_GameTraceChannel14",
  "L_ECC_GameTraceChannel15",
  "L_ECC_GameTraceChannel16",
  "L_ECC_GameTraceChannel17",
  "L_ECC_GameTraceChannel18",
  "L_ECC_OverlapAll_Deprecated",
]);
/** Tile, Crop and Fit exist in the engine but ship hidden, so they stay out of reach here. */
const scaleTypeEnum = z.enum(["Stretch", "Slice"]);
const mobilityEnum = z
  .enum(["Static", "Movable"])
  .describe("Movable or Static; settable only on top-level Workspace objects (direct children of Workspace).");

/**
 * Universal base-Instance properties present on every instance class (comparable to ClassName/Name),
 * injected into each instance-class schema below. Services are excluded — they are singletons, not
 * Workspace objects.
 */
const instanceBaseProperties = {
  Mobility: mobilityEnum.optional(),
};
/**
 * A sequence is the one value whose shape differs, not just its tag: keypoints are written as a
 * list and Studio wants that list under `Keypoints` — "Property Color expects Object, but received
 * Array" otherwise. A ColorSequence keypoint names its colour `Value`. The list stays the argument
 * so the caller writes what reads like a sequence.
 */
const colorSequence = z
  .array(z.object({ Time: z.number(), Color: rgb }))
  .describe("ColorSequence keypoints [{Time,Color}]")
  .transform((keypoints) => ({
    ObjectType: "ColorSequence" as const,
    Keypoints: keypoints.map(({ Time, Color }) => ({ Time, Value: Color })),
  }));
/**
 * A VFXRecipe layer takes the keypoints as the list itself; the wrapped form is accepted and then
 * stored empty, with nothing on the response to say so. An instance property is the opposite — it
 * is the wrapped form that Studio keeps. Same spelling in, different type out, so the two are
 * declared apart. Measured 2026-08-27.
 */
const vfxNumberSequence = z
  .array(z.object({ Time: z.number(), Value: z.number(), Envelope: z.number().optional() }))
  .describe("NumberSequence keypoints [{Time,Value,Envelope?}]");
const numberSequence = vfxNumberSequence.transform((Keypoints) => ({
  ObjectType: "NumberSequence" as const,
  Keypoints,
}));
const numberRange = tagged("NumberRange", { Min: z.number(), Max: z.number() });
/** Studio requires all three: a Font missing Style or Weight is rejected, and one it accepts reads back with both. */
const fontFace = tagged("Font", {
  Family: z.string(),
  Style: z.enum(["Normal", "Italic"]).default("Normal"),
  Weight: z
    .enum(["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"])
    .default("Regular"),
});
const nineSliceProperties = {
  ScaleType: scaleTypeEnum
    .describe("How the image fills the element. Slice keeps the corners at their source size.")
    .optional(),
  SliceCenter: rect
    .describe("9-slice boundaries in source-image pixels from the top-left. Applies when ScaleType is Slice.")
    .optional(),
  SliceScale: z.number().describe("Multiplier for 9-slice edge thickness. Default 1.").optional(),
};
/** SimulationBall's solver seed state. Every field is required once the object is supplied. */
const ballSimParams = tagged("BallSimParams", {
  BaseGravity: z.number(),
  DampingAngular: z.number(),
  DampingLinear: z.number(),
  EnableGravityFalloff: z.boolean(),
  Friction: z.number(),
  GravityFalloffEndHeight: z.number(),
  GravityFalloffStartHeight: z.number(),
  InertiaScale: z.number(),
  InitialCFrame: cframe,
  InitialDirection: vec3,
  InitialSpeed: z.number(),
  InitialSpinAxis: vec3,
  InitialSpinSpeed: z.number(),
  Mass: z.number(),
  MaxSpeedForMagnus: z.number(),
  MinFalloffGravity: z.number(),
  MinSpeedForMagnus: z.number(),
  MinSpinForMagnus: z.number(),
  Restitution: z.number(),
  RollingFriction: z.number(),
  Simsteps: z.number(),
  SpinMagnusWeight: z.number(),
  StepsPerSecond: z.number(),
  bForwardSpaceSpinAxis: z.boolean(),
});
const surfaceGuiBaseProperties = {
  Active: z.boolean().default(true),
  AlwaysOnTop: z.boolean().optional(),
  AutoLocalize: z.boolean().optional(),
  Brightness: z.number().default(1),
  ClipsDescendants: z.boolean().default(true),
  Enabled: z.boolean().default(true),
  LightInfluence: z.number().describe("(0~1)").default(1),
  MaxDistance: z.number().default(3000),
  ZIndexBehavior: z.string().describe('e.g. "Sibling"').optional(),
};

const guiObjectProperties = {
  Active: z.boolean().default(true),
  AnchorPoint: vec2.optional(),
  AutoLocalize: z.boolean().optional(),
  BackgroundColor3: rgb.optional(),
  BackgroundTransparency: z.number().describe("(0~1)").optional(),
  ClipsDescendants: z.boolean().optional(),
  LayoutOrder: z.number().optional(),
  Position: udim2.describe("UI position (UDim2)").optional(),
  Rotation: z.number().optional(),
  Size: udim2.describe("UI size (UDim2)").optional(),
  Visible: z.boolean().default(true),
  ZIndex: z.number().optional(),
};

const textProperties = {
  FontFace: fontFace.optional(),
  Text: z.string().optional(),
  TextColor3: rgb.optional(),
  TextScaled: z.boolean().optional(),
  TextSize: z.number().default(14),
  TextTransparency: z.number().describe("(0~1)").optional(),
  TextWrapped: z.boolean().optional(),
  TextXAlignment: z.string().describe('e.g. "Left"').optional(),
  TextYAlignment: z.string().describe('e.g. "Top"').optional(),
};

// --- VFXRecipe layer sources ---
// Serialized VFXRecipe layer items carry ObjectType tags on Vector3/Color3/Content values
// (see the .ovdrjm sample extraction); the literal defaults below inject them automatically.
const vfxVec3 = z.object({
  ObjectType: z.literal("Vector3").default("Vector3"),
  X: z.number(),
  Y: z.number(),
  Z: z.number(),
});
const vfxColorSequence = z
  .array(
    z.object({
      ObjectType: z.literal("Color3").default("Color3"),
      R: colorChannel,
      G: colorChannel,
      B: colorChannel,
      Time: z.number().describe("(0~1)"),
    }),
  )
  .describe("Particle color keypoints over the source lifetime [{R,G,B,Time}]");

// The full serving-asset path is derivable entirely from layer + source name, so the model-facing
// enum carries only short names (the instance_upsert schema is the heaviest tool schema already)
// and the sidecar expands them here. Full paths pasted from recipe-template payloads are also
// accepted: preprocess strips them back to the short name, and the per-layer enum still rejects
// sources belonging to another layer.
const vfxSourceShortName = (value: unknown) =>
  typeof value === "string" ? value.replace(/^.*VFX_UGC_(?:Base|Detail|Extra)_/, "").split(".")[0] : value;

/** Builds the per-layer NiagaraSystem field: short-name enum in, full serving-asset path out. */
function vfxNiagaraSystem(layerDir: string, prefix: string, names: readonly [string, ...string[]]) {
  return z
    .preprocess(
      vfxSourceShortName,
      z
        .enum(names)
        .describe(
          "VFX source to play, by short name. Sources with _R in the name are Rate emitters (Duration/SpawnRate); the rest are Burst emitters (SpawnCount).",
        ),
    )
    .transform(
      (name) => `/CommonContent/VFX/Layer/${layerDir}/${name}/VFX_UGC_${prefix}_${name}.VFX_UGC_${prefix}_${name}`,
    );
}

/**
 * One source item inside a VFXRecipe layer. Every serving source exposes a subset of these user
 * parameters — unsupported parameters are ignored by the source asset, so set only the ones the
 * chosen NiagaraSystem provides.
 */
function vfxLayerSourceArray(niagaraSystem: z.ZodTypeAny) {
  return z.array(
    z
      .object({
        Name: z.string().describe("Source identifier used by GetParam/SetParam/GetParamAt/SetParamAt"),
        NiagaraSystem: niagaraSystem,
        Texture: z
          .object({
            ObjectType: z.literal("Content").default("Content"),
            Content: z.string().describe('Texture asset ID, e.g. "ovdrassetid://2793112"'),
          })
          .describe("Overrides the source texture; omit to keep the asset default")
          .optional(),
        Position: vfxVec3.describe("Local position relative to the VFXRecipe root").optional(),
        Rotation: vfxVec3.describe("Local rotation relative to the VFXRecipe root").optional(),
        Acceleration: vec3.describe("Particle acceleration").optional(),
        BoundSize: vec3.describe("Size of the particle spawn bounds").optional(),
        Color: vfxColorSequence.optional(),
        Alpha: vfxNumberSequence
          .describe("Alpha (opacity) keypoints over the source lifetime [{Time,Value}], 0~1")
          .optional(),
        Delay: z.number().describe("Playback start delay in seconds").optional(),
        Duration: z.number().describe("Emitter duration in seconds (Rate sources only)").optional(),
        SpawnRate: z.number().describe("Particles per second (Rate sources only)").optional(),
        SpawnCount: z.number().describe("Particles per activation (Burst sources only)").optional(),
        Lifetime_Min: z.number().describe("Particle minimum lifetime in seconds").optional(),
        Lifetime_Max: z.number().describe("Particle maximum lifetime in seconds").optional(),
        LoopDuration: z
          .number()
          .describe("Auto-filled from the recipe across all sources; keep identical on every source item")
          .optional(),
        Size: z.number().describe("Particle size scale").optional(),
        Size2D: z
          .object({ X: z.number(), Y: z.number() })
          .describe("Particle width/height (sprite sources)")
          .optional(),
        Scale: z.number().describe("Scale value used by decal-type sources").optional(),
        Speed: z.number().describe("Particle movement/playback speed").optional(),
        Transparency: z.number().describe("(0~1)").optional(),
        FlipbookMode: z.number().int().describe("Flipbook animation playback mode").optional(),
        FlipbookRows: z.number().int().optional(),
        FlipbookColumns: z.number().int().optional(),
      })
      .strict(),
  );
}

/** Per-layer VFX source short names — single source of truth for the NiagaraSystem enums. */
export const vfxLayerSourceNames = {
  Base: [
    "EmptySprite",
    "EmptySprite_R",
    "FireBurst_A",
    "FireRise_A",
    "LightBurst_A",
    "LightFlash_A",
    "LightFlash_B",
    "LightFlash_C",
    "LightRise_R_A",
    "LiquidFlash_A",
    "LiquidScatter_R_A",
    "NeutralBurst_A",
    "NeutralBurst_B",
    "NeutralTrail_A",
    "SmokeBurst_A",
    "SmokeRing_A",
    "TechDecal_R_A",
  ],
  Detail: [
    "FireDecal_A",
    "FireFlash_A",
    "FireScatter_B",
    "LightBurst_R_A",
    "LightRise_R_B",
    "LightRise_R_C",
    "LightShimmer_A",
    "LightShimmer_R_B",
    "NeutralDecal_A",
    "NeutralFlash_C",
    "NeutralPulse_R_A",
    "NeutralRing_B",
    "SmokeBurst_A",
    "SmokeTrail_A",
  ],
  Extra: [
    "FireScatter_C",
    "FireScatter_D",
    "LightRise_R_A",
    "LightningScatter_A",
    "LiquidScatter_R_A",
    "MagicRing_A",
    "NeutralRing_A",
    "SmokeRise_A",
  ],
} as const;

const vfxBaseLayerSchema = vfxLayerSourceArray(vfxNiagaraSystem("0_Base", "Base", vfxLayerSourceNames.Base));
const vfxDetailLayerSchema = vfxLayerSourceArray(vfxNiagaraSystem("1_Detail", "Detail", vfxLayerSourceNames.Detail));
const vfxExtraLayerSchema = vfxLayerSourceArray(vfxNiagaraSystem("2_Extra", "Extra", vfxLayerSourceNames.Extra));

export const instanceClassEnum = z.enum([
  "Part",
  "Outline",
  "Fill",
  "Frame",
  "ImageButton",
  "ImageLabel",
  "TextButton",
  "TextLabel",
  "Sound",
  "RemoteEvent",
  "Tool",
  "VFXPreset",
  "VFXRecipe",
  "AngularVelocity",
  "LinearVelocity",
  "VectorForce",
  "Model",
  "Folder",
  "ScrollingFrame",
  "UIListLayout",
  "UIGridLayout",
  "BillboardGui",
  "SurfaceGui",
  "BindableEvent",
  "Attachment",
  "Beam",
  "Trail",
  "ParticleEmitter",
  "PointLight",
  "SpotLight",
  "StringValue",
  "NumberValue",
  "BoolValue",
  "IntValue",
  "MeshPart",
  "Animation",
  "HumanoidDescription",
  "Camera",
  "MaterialVariant",
  "ScreenGui",
  "SimulationBall",
  "SoundGroup",
  "SpawnLocation",
  "UIAspectRatioConstraint",
  "ProximityPrompt",
  "UIStroke",
  "ActionSequence",
  "Bone",
  "Constraint",
  "Humanoid",
  "LocalScript",
  "ModuleScript",
  "ProgressBar",
  "Script",
  "Skeleton",
  "Team",
  "UIGridStyleLayout",
  "WrapLayer",
]);

export const serviceClassEnum = z.enum([
  "Workspace",
  "Lighting",
  "Atmosphere",
  "Players",
  "StarterPlayer",
  "MaterialService",
  "HttpService",
  "CollectionService",
  "DataModel",
  "DataStoreService",
  "PhysicsService",
  "RunService",
  "ServerScriptService",
  "ServerStorage",
  "StarterCharacterScripts",
  "StarterGui",
  "StarterPlayerScripts",
  "ReplicatedStorage",
]);

export const materialEnum = z.enum([
  "Basic",
  "Plastic",
  "Brick",
  "Rock",
  "Metal",
  "Unlit",
  "Bark",
  "SmallBrick",
  "LeafyGround",
  "MossyGround",
  "Ground",
  "Glass",
  "Paving",
  "MossyRock",
  "Plank",
  "Wood",
  "Neon",
  "Asphalt",
  "Concrete",
  "Marble",
  "MetalPlate",
  "Rust",
  "Snow",
  "StoneBrick",
  "StoneFloor",
  "SilverMetal",
  "CorrugatedSteel",
  "Sand",
  "Grass",
  "PavingStones",
  "Road",
  "WhiteGrayBrick",
  "ConcretePlate",
  "Roof",
  "GridQuad",
  "DistroyedBronze",
  "HalfLeafyGround",
  "PavingWall",
  "GridBox",
  "RustBrass",
  "PavingFloor",
  "GridTile",
  "PavingBrick",
  "GridPentagon",
  "GridMarble",
  "Copper",
  "TerrazzoFloor",
  "CheckerTileFloor",
  "SoilRockGround",
  "PavingBlock",
  "MixRoad",
  "HouseBricks",
  "BrokenConcrete",
  "DamagedRoof",
  "OfficeCeilingWhite",
  "CementWall",
  "CrackedSmallCeramicTile",
  "CrackedMiddleCeramicTile",
  "TakenOffCeramicTile",
  "MosaicCarpet",
  "BrushMetal",
  "PaintedMetal",
  "PaintedWood",
  "IndustrialRibbedSteel",
  "PeelingPaintSteel",
  "RustySteel",
  "UrbanSlateFloor",
  "BeigeTerrazzoFloor",
  "GreyWovenFabric",
  "ThickCarpet",
  "EmeraldGridTile",
  "OceanPanelTile",
  "BrickCeramicTile",
  "SquareCeramicTile",
  "GridBorder",
  "GalvanizedMetal",
  "WeatheredPlasterBrick",
  "WhiteCementBrick",
  "SandstoneBrick",
  "BrokenRoof",
  "Foil",
  "RustMetal",
  "PaintedWornWood",
  "Chainmail",
  "WoodTileFloor",
  "Tatami",
  "OfficeCeilingLight",
  "WoodSidingWall",
  "WoodLogSidingWall",
  "FabricDenim",
  "FabricWeave",
  "GrainLeather",
  "CrocEmbossedLeather",
  "MatteRubber",
]);

// --- Service property schemas (update-only, not insertable) ---

const workspaceServiceSchema = z
  .object({
    AllowDebugDraw: z.boolean().describe("Enables WorldRoot Draw* debug rendering.").optional(),
    Gravity: z.number().optional(),
    HitboxType: z.string().describe('e.g. "Single"').optional(),
  })
  .strict()
  .describe("Use when updating Workspace service. Controls world gravity and hitbox type.");

const lightingServiceSchema = z
  .object({
    AmbientSkyBrightness: z.number().max(10).optional(),
    AmbientSkyColor: rgb.optional(),
    AutoTimeCycle: z.boolean().optional(),
    ClockTime: z.number().optional(),
    Contrast: z.number().max(2).optional(),
    GroundReflectionColor: rgb.optional(),
    MoonBrightness: z.number().max(3).optional(),
    MoonCastShadow: z.boolean().optional(),
    MoonLightColor: rgb.optional(),
    MoonMaterialColor: rgb.optional(),
    MoonMaxHeight: z.number().max(90).optional(),
    MoonPathAngle: z.number().optional(),
    MoonPhase: z.number().max(30).optional(),
    NightBrightness: z.number().max(3).optional(),
    Saturation: z.number().max(2).optional(),
    ShadowDetailLevel: z.enum(["Original", "Medium", "Low"]).optional(),
    SkyColorInfluence: z.number().optional(),
    StarsBrightness: z.number().max(8).optional(),
    StarsColor: rgb.optional(),
    SunBrightness: z.number().max(50).optional(),
    SunCastShadow: z.boolean().optional(),
    SunLightColor: rgb.optional(),
    SunMaxHeight: z.number().max(85).optional(),
    SunPathAngle: z.number().optional(),
    TimeFlowSpeed: z.number().optional(),
  })
  .strict()
  .describe("Use when updating Lighting service. Controls time of day, sun/moon, sky colors, and ambient lighting.");

const atmosphereServiceSchema = z
  .object({
    AirColor: rgb.optional(),
    CloudAmount: z.number().optional(),
    CloudSpeed: z.number().optional(),
    CloudTexture: z.string().optional(),
    FogColor: rgb.optional(),
    FogDensity: z.number().optional(),
    FogFalloff: z.number().optional(),
    FogHorizon: z.boolean().optional(),
    FogStart: z.number().optional(),
    GlareColor: rgb.optional(),
    GlareFalloff: z.number().optional(),
    HazeColor: rgb.optional(),
    HazeSpread: z.number().optional(),
  })
  .strict()
  .describe("Use when updating Atmosphere service. Controls fog, haze, glare, and cloud settings.");

const playersServiceSchema = z
  .object({
    CharacterAutoLoads: z.boolean().optional(),
    RespawnTime: z.number().optional(),
    UseStrafingAnimations: z.boolean().optional(),
  })
  .strict()
  .describe("Use when updating Players service. Controls character auto-loading and respawn settings.");

const starterPlayerServiceSchema = z
  .object({
    AirControl: z.number().optional(),
    CameraMaxZoomDistance: z.number().optional(),
    CameraMinZoomDistance: z.number().optional(),
    CapsuleHeight: z.number().optional(),
    CapsuleRadius: z.number().optional(),
    CharacterMeshPos: vec3.optional(),
    FallingDeceleration: z.number().optional(),
    FallingLateralFriction: z.number().optional(),
    GravityScale: z.number().optional(),
    GroundFriction: z.number().optional(),
    IgnoreBaseRotation: z.boolean().optional(),
    JumpHeight: z.number().optional(),
    JumpPower: z.number().optional(),
    LoadCharacterAppearance: z.boolean().optional(),
    MaxAcceleration: z.number().optional(),
    MaxJumpCount: z.number().optional(),
    MaxSlopeAngle: z.number().optional(),
    RotationSpeed: z.number().optional(),
    StompJumpMultiplier: z.number().optional(),
    UseJumpPower: z.boolean().optional(),
    WalkSpeed: z.number().optional(),
    WalkingDeceleration: z.number().optional(),
  })
  .strict()
  .describe("Use when updating StarterPlayer service. Controls character movement, physics, and camera settings.");

const materialServiceSchema = z
  .object(
    Object.fromEntries(
      [
        "Asphalt",
        "Bark",
        "Basic",
        "BeigeTerrazzoFloor",
        "Brick",
        "BrickCeramicTile",
        "BrokenConcrete",
        "BrokenRoof",
        "BrushMetal",
        "CementWall",
        "Chainmail",
        "CheckerTileFloor",
        "Concrete",
        "ConcretePlate",
        "Copper",
        "CorrugatedSteel",
        "CrackedMiddleCeramicTile",
        "CrackedSmallCeramicTile",
        "CrocEmbossedLeather",
        "DamagedRoof",
        "DistroyedBronze",
        "EmeraldGridTile",
        "FabricDenim",
        "FabricWeave",
        "Foil",
        "GalvanizedMetal",
        "Glass",
        "GrainLeather",
        "Grass",
        "GreyWovenFabric",
        "GridBorder",
        "GridBox",
        "GridMarble",
        "GridPentagon",
        "GridQuad",
        "GridTile",
        "Ground",
        "HalfLeafyGround",
        "HouseBricks",
        "IndustrialRibbedSteel",
        "LeafyGround",
        "Marble",
        "MatteRubber",
        "Metal",
        "MetalPlate",
        "MixRoad",
        "MosaicCarpet",
        "MossyGround",
        "MossyRock",
        "OceanPanelTile",
        "OfficeCeilingLight",
        "OfficeCeilingWhite",
        "PaintedMetal",
        "PaintedWood",
        "PaintedWornWood",
        "Paving",
        "PavingBlock",
        "PavingBrick",
        "PavingFloor",
        "PavingStones",
        "PavingWall",
        "PeelingPaintSteel",
        "Plank",
        "Plastic",
        "Road",
        "Rock",
        "Roof",
        "Rust",
        "RustBrass",
        "RustMetal",
        "RustySteel",
        "Sand",
        "SandstoneBrick",
        "SilverMetal",
        "SmallBrick",
        "Snow",
        "SoilRockGround",
        "SquareCeramicTile",
        "StoneBrick",
        "StoneFloor",
        "TakenOffCeramicTile",
        "Tatami",
        "TerrazzoFloor",
        "ThickCarpet",
        "Unlit",
        "UrbanSlateFloor",
        "WeatheredPlasterBrick",
        "WhiteCementBrick",
        "WhiteGrayBrick",
        "Wood",
        "WoodLogSidingWall",
        "WoodSidingWall",
        "WoodTileFloor",
      ].map((n) => [n, z.string().optional()]),
    ) as Record<string, z.ZodOptional<z.ZodString>>,
  )
  .strict()
  .describe("Use when updating MaterialService. Each property maps a base material to its custom variant name.");

const emptyServiceSchema = z.object({}).strict();

const rawInstancePropertiesUnion = z.union([
  z
    .object({
      Shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
      CFrame: cframe.optional(),
      Size: vec3.describe("units in cm").optional(),
      Anchored: z.boolean().default(true),
      AssemblyLinearVelocity: vec3.optional(),
      CanClimb: z.boolean().optional(),
      CanCollide: z.boolean().default(true),
      CanQuery: z.boolean().default(true),
      CanTouch: z.boolean().default(true),
      CastShadow: z.boolean().optional(),
      CollisionProfile: z.string().describe('e.g. "BlockAll"').optional(),
      Color: rgb.optional(),
      CustomPhysicalProperties: physicalProperties.optional(),
      Locked: z.boolean().optional(),
      Material: materialEnum.optional(),
      MaterialVariant: z.string().optional(),
      PivotOffsetCFrame: cframe.optional(),
      TraceGroupNameString: z.string().optional(),
      Transparency: z.number().describe("(0~1)").optional(),
    })
    .strict()
    .describe("Use when class=Part. A 3D primitive shape (Block, Ball, Cylinder) with physics and collision."),
  z
    .object({
      Color: rgb.optional(),
      Thickness: z.number().optional(),
      Enabled: z.boolean().optional(),
    })
    .strict()
    .describe("Use when class=Outline. Overlay effect with edge color/thickness around an adornee instance."),
  z
    .object({
      Color: rgb.optional(),
      DepthMode: z.enum(["AlwaysOnTop", "VisibleWhenNotOccluded", "VisibleWhenOccluded"]).optional(),
      Transparency: z.number().describe("(0~1)").optional(),
      Enabled: z.boolean().optional(),
    })
    .strict()
    .describe("Use when class=Fill. Overlay effect with color fill over an adornee instance."),
  z
    .object({
      ...guiObjectProperties,
      BorderColor3: rgb.optional(),
      BorderMode: z.enum(["Insert", "Middle", "Outline"]).optional(),
      BorderPixelSize: z.number().optional(),
    })
    .strict()
    .describe("Use when class=Frame. Layout and visual properties with optional border styling."),
  z
    .object({
      Image: z.string().describe("Image asset ID").optional(),
      ImageColor3: rgb.default({ R: 255, G: 255, B: 255 }),
      ImageTransparency: z.number().describe("(0~1)").optional(),
      PressImage: z.string().describe("Image asset ID").optional(),
      HoverImage: z.string().describe("Image asset ID").optional(),
      ...nineSliceProperties,
      ...guiObjectProperties,
    })
    .strict()
    .describe("Use when class=ImageButton. Clickable GUI element that displays an image with press/hover states."),
  z
    .object({
      Image: z.string().describe("Image asset ID").optional(),
      ImageColor3: rgb.optional(),
      ImageTransparency: z.number().describe("(0~1)").optional(),
      ...nineSliceProperties,
      ...guiObjectProperties,
    })
    .strict()
    .describe("Use when class=ImageLabel. Non-interactive GUI element that displays an image."),
  z
    .object({ ...textProperties, ...guiObjectProperties })
    .strict()
    .describe("Use when class=TextButton. Clickable GUI element that displays text."),
  z
    .object({ ...textProperties, ...guiObjectProperties })
    .strict()
    .describe("Use when class=TextLabel. Same as TextButton properties but non-interactive."),
  z
    .object({
      SoundId: z.string().optional(),
      Volume: z.number().describe("multiplier (0~10)").default(0.5),
      Looped: z.boolean().optional(),
      LoopRegion: z.object({ Min: z.number(), Max: z.number() }).optional(),
      PlaybackRegion: z.object({ Min: z.number(), Max: z.number() }).optional(),
      PlaybackRegionsEnabled: z.boolean().default(false),
      PlaybackSpeed: z.number().default(1),
      Playing: z.boolean().optional(),
      PlayOnRemove: z.boolean().optional(),
      RollOffMaxDistance: z.number().default(5000),
      RollOffMinDistance: z.number().default(10),
      RollOffMode: z.enum(["Inverse", "InverseTapered", "Linear", "LinearSquare"]).optional(),
      StartTimePosition: z.number().optional(),
      TimePosition: z
        .number()
        .min(0)
        .describe("Playback position in seconds; settable before and during playback.")
        .optional(),
    })
    .strict()
    .describe("Use when class=Sound. Audio source with 3D spatial roll-off."),
  z
    .object({})
    .strict()
    .describe("Use when class=RemoteEvent. No configurable properties — just set parentGuid and name."),
  z
    .object({
      CanBeDropped: z.boolean().default(true),
      Enabled: z.boolean().optional(),
      Grip: cframe.describe("The tool's grip offset, as one CFrame.").optional(),
      TextureId: z.string().describe("Icon shown for the tool in the player's backpack.").optional(),
    })
    .strict()
    .describe("Use when class=Tool. An equippable item a player can pick up and activate."),
  z
    .object({
      PresetName: z
        .string()
        .describe(
          'Preset resource name, e.g. "VFX_UGC_Muzzle_01" — discover via the vfx-recipe skill (references/presets.md, Resource column)',
        ),
      Alpha: z
        .array(z.object({ Time: z.number(), Value: z.number() }))
        .describe("Alpha curve keypoints [{Time,Value}]")
        .optional(),
      Color: z.array(z.object({ Time: z.number(), R: z.number(), G: z.number(), B: z.number() })),
      Enabled: z.boolean().default(true),
      Importance: z.string().optional(),
      InfiniteLoop: z.boolean().default(true),
      LoopCount: z.number().default(1),
      Size: z.number().default(1),
      Transparency: z.number().describe("(0~1)").optional(),
    })
    .strict()
    .describe("Use when class=VFXPreset. A named visual effects preset for quick particle effect setup."),
  z
    .object({
      AutoActivate: z.boolean().default(true),
      InfiniteLoop: z.boolean().default(true),
      LoopCount: z.number().default(1),
      // Read-only derived value: accepted so recipe-template payloads can be pasted verbatim,
      // then stripped (undefined is dropped by JSON.stringify) — Studio re-derives it.
      LoopDuration: z
        .number()
        .optional()
        .transform(() => undefined)
        .describe("Read-only derived value; accepted for template-payload compatibility and ignored."),
      BaseLayer: vfxBaseLayerSchema.optional(),
      DetailLayer: vfxDetailLayerSchema.optional(),
      ExtraLayer: vfxExtraLayerSchema.optional(),
    })
    .strict()
    .describe(
      "Use when class=VFXRecipe. Custom layered VFX composed of Base/Detail/Extra layer source items, " +
        "each playing a serving VFX source asset with per-source user parameters. " +
        "Compose via the vfx-recipe skill (bundled templates in references/templates/).",
    ),
  z
    .object({
      AngularVelocity: vec3.optional(),
      Enabled: z.boolean().default(true),
      MaxTorque: z.number().default(1000),
      RelativeTo: z.string().describe('e.g. "World"').optional(),
    })
    .strict()
    .describe("Use when class=AngularVelocity. Applies a target rotational velocity to a physics body."),
  z
    .object({
      VelocityConstraintMode: z
        .enum(["Vector"])
        .describe("Line and Plane exist in the editor but their parameters are not serialized.")
        .optional(),
      VectorVelocity: vec3.optional(),
      Enabled: z.boolean().default(true),
      ForceLimitsEnabled: z.boolean().default(true),
      MaxForce: z.number().default(10),
      RelativeTo: z.string().describe('e.g. "World"').optional(),
    })
    .strict()
    .describe("Use when class=LinearVelocity. Applies a target linear velocity to a physics body along a vector."),
  z
    .object({
      Force: vec3.optional(),
      ApplyAtCenterOfMass: z.boolean().optional(),
      Enabled: z.boolean().default(true),
      RelativeTo: z.string().describe('e.g. "World"').optional(),
    })
    .strict()
    .describe(
      "Use when class=VectorForce. Applies a constant force vector to a physics body, optionally at its center of mass.",
    ),
  z
    .object({
      CastShadow: z.boolean().optional(),
      PivotOffsetCFrame: cframe.optional(),
      WorldPivot: cframe.optional(),
    })
    .strict()
    .describe(
      "Use when class=Model. Groups BaseParts into a single unit; supports physics, movement, and rotation as one entity.",
    ),
  z
    .object({})
    .strict()
    .describe(
      "Use when class=Folder. Logical organizer with no class-specific properties — use for grouping scripts or non-physical instances.",
    ),
  z
    .object({
      AutomaticCanvasSize: z.string().describe('e.g. "Y"').optional(),
      CanvasPosition: z.object({ X: z.number(), Y: z.number() }).describe("Scroll offset (Vector2)").optional(),
      CanvasSize: udim2.describe("Total scrollable area (UDim2)").optional(),
      ScrollBarImageColor3: rgb.optional(),
      ScrollBarImageTransparency: z.number().describe("(0~1)").optional(),
      ScrollBarThickness: z.number().default(12),
      ScrollingDirection: z.string().describe('e.g. "Y"').optional(),
      ScrollingEnabled: z.boolean().default(true),
      ...guiObjectProperties,
      ClipsDescendants: z.boolean().default(true),
    })
    .strict()
    .describe(
      "Use when class=ScrollingFrame. Scrollable UI container; use for inventory lists, quest logs, or any overflowing content.",
    ),
  z
    .object({
      Padding: udim.describe("Space between list items (UDim)").optional(),
      Wraps: z.boolean().optional(),
      FillDirection: z.string().describe('e.g. "Vertical"').optional(),
      HorizontalAlignment: z.string().describe('e.g. "Center"').optional(),
      VerticalAlignment: z.string().describe('e.g. "Top"').optional(),
      SortOrder: z.string().describe('e.g. "LayoutOrder"').optional(),
    })
    .strict()
    .describe("Use when class=UIListLayout. Auto-arranges sibling UI elements in a horizontal or vertical list."),
  z
    .object({
      CellPadding: udim2.describe("Space between grid cells (UDim2)").optional(),
      CellSize: udim2.describe("Uniform size of each grid cell (UDim2)").optional(),
      FillDirectionMaxCells: z.number().int().optional(),
      FillDirection: z.string().describe('e.g. "Horizontal"').optional(),
      HorizontalAlignment: z.string().describe('e.g. "Left"').optional(),
      VerticalAlignment: z.string().describe('e.g. "Top"').optional(),
      SortOrder: z.string().describe('e.g. "LayoutOrder"').optional(),
    })
    .strict()
    .describe("Use when class=UIGridLayout. Auto-arranges sibling UI elements in a uniform grid."),
  z
    .object({
      ...surfaceGuiBaseProperties,
      DistanceLowerLimit: z.number().optional(),
      DistanceUpperLimit: z.number().optional(),
      ExtentsOffsetWorldSpace: vec3.optional(),
      PositionOffset: vec3.optional(),
      PositionOffsetWorldSpace: vec3.optional(),
      Size: udim2.describe("Canvas size (UDim2)").optional(),
      SizeOffset: z.object({ X: z.number(), Y: z.number() }).describe("Screen-space size offset (Vector2)").optional(),
    })
    .strict()
    .describe("Use when class=BillboardGui. World-space GUI that always faces the camera, anchored to an Adornee."),
  z
    .object({
      ...surfaceGuiBaseProperties,
      Face: normalIdEnum.optional(),
      Size: udim2.describe("Canvas size (UDim2)").optional(),
      ZOffset: z.number().default(1),
    })
    .strict()
    .describe("Use when class=SurfaceGui. GUI rendered on a specific face of a Part."),
  z
    .object({})
    .strict()
    .describe("Use when class=BindableEvent. No configurable properties — just set parentGuid and name."),
  z
    .object({
      Axis: vec3.optional(),
      CFrame: cframe.optional(),
      SecondaryAxis: vec3.optional(),
      WorldAxis: vec3.describe("Unit direction of the attachment's X axis in world space.").optional(),
      WorldCFrame: cframe.optional(),
      WorldSecondaryAxis: vec3.describe("Unit direction of the attachment's Y axis in world space.").optional(),
    })
    .strict()
    .describe("Use when class=Attachment. Defines a local coordinate frame on a BasePart for constraints and effects."),
  z
    .object({
      Color: colorSequence.optional(),
      CurveSize0: z.number().optional(),
      CurveSize1: z.number().optional(),
      Enabled: z.boolean().default(true),
      FaceCamera: z.boolean().optional(),
      Texture: z.string().describe("Texture asset ID").optional(),
      TextureLength: z.number().default(1),
      TextureSpeed: z.number().default(1),
      Transparency: numberSequence.optional(),
      Width0: z.number().default(1),
      Width1: z.number().default(1),
    })
    .strict()
    .describe("Use when class=Beam. Visual beam rendered between two Attachments."),
  z
    .object({
      Color: colorSequence.optional(),
      Enabled: z.boolean().default(true),
      Lifetime: z.number().default(2),
      Offset: vec3.optional(),
      Texture: z.string().describe("Texture asset ID").optional(),
      TextureLength: z.number().default(1),
      TextureSpeed: z.number().default(1),
      Transparency: numberSequence.optional(),
      Width: z.number().default(200),
      WidthScale: numberSequence.optional(),
    })
    .strict()
    .describe("Use when class=Trail. Motion trail rendered between two Attachments."),
  z
    .object({
      Acceleration: vec3.optional(),
      Brightness: z.number().optional(),
      Color: colorSequence.optional(),
      Drag: z.number().optional(),
      EmissionDirection: normalIdEnum.optional(),
      Enabled: z.boolean().default(true),
      FlipbookFramerate: numberRange.optional(),
      FlipbookLayout: z.enum(["None", "Grid2x2", "Grid4x4", "Grid8x8"]).optional(),
      FlipbookMode: z.enum(["Loop", "OneShot", "PingPong", "Random"]).optional(),
      FlipbookStartRandom: z.boolean().optional(),
      Lifetime: numberRange.optional(),
      LightEmission: z.number().describe("(0~1)").optional(),
      LockedToPart: z.boolean().optional(),
      Orientation: z
        .enum(["FacingCamera", "FacingCameraWorldUp", "VelocityParallel", "VelocityPerpendicular"])
        .optional(),
      Rate: z.number().default(5),
      RotSpeed: z.number().optional(),
      Rotation: numberRange.optional(),
      Shape: z.enum(["Box", "Sphere", "Cylinder", "Disc"]).optional(),
      ShapeInOut: z.enum(["OutWard", "InWard"]).optional(),
      ShapeStyle: z.enum(["Volume", "Surface"]).optional(),
      Size: numberSequence.optional(),
      Speed: numberRange.optional(),
      SpreadAngle: z.number().optional(),
      Squash: numberSequence.optional(),
      Texture: z.string().describe("Texture asset ID").optional(),
      Transparency: numberSequence.optional(),
    })
    .strict()
    .describe(
      "Use when class=ParticleEmitter. Full particle system with emission shape, flipbook animation, and physics.",
    ),
  z
    .object({
      Brightness: z.number().default(50),
      Color: rgb.optional(),
      Enabled: z.boolean().optional(),
      Range: z.number().describe("Radius of illumination in studs").default(300),
    })
    .strict()
    .describe("Use when class=PointLight. Omnidirectional point light source."),
  z
    .object({
      Angle: z.number().describe("Cone half-angle in degrees").default(45),
      Brightness: z.number().default(50),
      Color: rgb.optional(),
      Enabled: z.boolean().optional(),
      Face: normalIdEnum.optional(),
      Range: z.number().describe("Radius of illumination in studs").default(300),
    })
    .strict()
    .describe("Use when class=SpotLight. Cone-shaped directional light source."),
  z
    .object({ Value: z.string().optional() })
    .strict()
    .describe("Use when class=StringValue. Stores a single string value."),
  z
    .object({ Value: z.number().optional() })
    .strict()
    .describe("Use when class=NumberValue. Stores a single floating-point value."),
  z
    .object({ Value: z.boolean().optional() })
    .strict()
    .describe("Use when class=BoolValue. Stores a single boolean value."),
  z
    .object({ Value: z.number().int().optional() })
    .strict()
    .describe("Use when class=IntValue. Stores a single integer value."),
  z
    .object({
      CFrame: cframe.optional(),
      Size: vec3.describe("units in cm").optional(),
      Anchored: z.boolean().default(true),
      AssemblyLinearVelocity: vec3.optional(),
      CanClimb: z.boolean().optional(),
      CanCollide: z.boolean().default(true),
      CanQuery: z.boolean().default(true),
      CanTouch: z.boolean().default(true),
      CastShadow: z.boolean().optional(),
      CollisionProfile: z.string().describe('e.g. "BlockAll"').optional(),
      Color: rgb.optional(),
      CustomPhysicalProperties: physicalProperties.optional(),
      DoubleSided: z.boolean().optional(),
      EnableMeshShadowDetails: z.boolean().optional(),
      Locked: z.boolean().optional(),
      Material: materialEnum.optional(),
      MaterialVariant: z.string().optional(),
      MeshId: z.string().describe("Mesh asset ID").optional(),
      MeshShadowDetailLevel: z.enum(["Original", "Medium", "Low"]).optional(),
      PivotOffsetCFrame: cframe.optional(),
      TextureId: z.string().describe("Surface texture asset ID").optional(),
      TraceGroupNameString: z.string().optional(),
      Transparency: z.number().describe("(0~1)").optional(),
    })
    .strict()
    .describe(
      "Use when class=MeshPart. BasePart with a custom mesh asset. Inherits all Part physics/collision properties.",
    ),
  z
    .object({ AnimationId: z.string().describe("Animation asset ID").optional() })
    .strict()
    .describe("Use when class=Animation. References an animation asset to be loaded by an Animator."),
  z
    .object({
      Head: z.string().describe("Head mesh asset ID").optional(),
      Torso: z.string().describe("Torso mesh asset ID").optional(),
      LeftArm: z.string().describe("Left arm mesh asset ID").optional(),
      RightArm: z.string().describe("Right arm mesh asset ID").optional(),
      LeftLeg: z.string().describe("Left leg mesh asset ID").optional(),
      RightLeg: z.string().describe("Right leg mesh asset ID").optional(),
      HeadColor: rgb.optional(),
      TorsoColor: rgb.optional(),
      LeftArmColor: rgb.optional(),
      RightArmColor: rgb.optional(),
      LeftLegColor: rgb.optional(),
      RightLegColor: rgb.optional(),
      HeadTextureId: z.string().describe("Head texture asset ID").optional(),
      TorsoTextureId: z.string().describe("Torso texture asset ID").optional(),
      LeftArmTextureId: z.string().describe("Left arm texture asset ID").optional(),
      RightArmTextureId: z.string().describe("Right arm texture asset ID").optional(),
      LeftLegTextureId: z.string().describe("Left leg texture asset ID").optional(),
      RightLegTextureId: z.string().describe("Right leg texture asset ID").optional(),
      IdleAnimation: z.string().describe("Animation asset ID").optional(),
      WalkAnimation: z.string().describe("Animation asset ID").optional(),
      RunAnimation: z.string().describe("Animation asset ID").optional(),
      JumpAnimation: z.string().describe("Animation asset ID").optional(),
      FallAnimation: z.string().describe("Animation asset ID").optional(),
      LandedAnimation: z.string().describe("Animation asset ID").optional(),
      ClimbAnimation: z.string().describe("Animation asset ID").optional(),
      SwimmingIdleAnimation: z.string().describe("Animation asset ID").optional(),
      SwimmingBreaststrokeAnimation: z.string().describe("Animation asset ID").optional(),
      SprintAnimation: z.string().describe("Animation asset ID").optional(),
      MoodAnimation: z.string().describe("Animation asset ID").optional(),
      DieAnimation: z.string().describe("Animation asset ID").optional(),
      HeightScale: z.number().describe("Character y-axis scale").default(1),
      DepthScale: z.number().describe("Character z-axis scale").default(1),
      WidthScale: z.number().describe("Character x-axis scale").default(1),
      HeadScale: z.number().default(1),
      BodyTypeScale: z.number().default(1),
      ProportionScale: z.number().default(1),
      Face: z.string().describe("Face asset ID").optional(),
      Shirt: z.string().describe("Shirt asset ID").optional(),
      Pants: z.string().describe("Pants asset ID").optional(),
      GraphicTShirt: z.string().describe("Graphic T-Shirt asset ID").optional(),
      HatAccessory: z.string().describe("Hat asset ID").optional(),
      HairAccessory: z.string().describe("Hair asset ID").optional(),
      FaceAccessory: z.string().describe("Face accessory asset ID").optional(),
      NeckAccessory: z.string().describe("Neck accessory asset ID").optional(),
      ShoulderAccessory: z.string().describe("Shoulder accessory asset ID").optional(),
      FrontAccessory: z.string().describe("Front accessory asset ID").optional(),
      BackAccessory: z.string().describe("Back accessory asset ID").optional(),
      WaistAccessory: z.string().describe("Waist accessory asset ID").optional(),
      AccessoryBlob: z.string().describe("JSON accessory blob").optional(),
      IdleVariations: z.array(z.string()).optional(),
    })
    .strict()
    .describe(
      "Use when class=HumanoidDescription. Defines a character's full appearance including body parts, animations, and accessories.",
    ),
  z
    .object({
      CFrame: cframe.optional(),
      CameraOffset: vec3.optional(),
      CameraType: z.enum(["Fixed", "Attach", "Watch", "Track", "Follow", "Custom", "Scriptable", "Orbital"]).optional(),
      EnableSmoothFollow: z.boolean().optional(),
      EnableSmoothRotation: z.boolean().optional(),
      FieldOfView: z.number().optional(),
      FollowMaxDistance: z.number().optional(),
      RotationInput: vec3.optional(),
      SmoothFollowSpeed: z.number().optional(),
      SmoothRotationSpeed: z.number().optional(),
    })
    .strict()
    .describe("Use when class=Camera. Controls the world camera view and behavior."),
  z
    .object({
      BaseMaterial: materialEnum.optional(),
      ColorMap: z.string().describe("Texture asset ID").optional(),
      CustomPhysicalProperties: physicalProperties.optional(),
      Metalness: z.number().describe("(0~1)").optional(),
      MetalnessMap: z.string().describe("Texture asset ID").optional(),
      MetersPerTile: z.number().optional(),
      NormalMap: z.string().describe("Texture asset ID").optional(),
      Roughness: z.number().describe("(0~1)").optional(),
      RoughnessMap: z.string().describe("Texture asset ID").optional(),
      UseCustomPhysicsProperties: z.boolean().optional(),
    })
    .strict()
    .describe("Use when class=MaterialVariant. Custom material override with PBR texture maps and surface color."),
  z
    .object({
      AutoLocalize: z.boolean().optional(),
      DisplayOrder: z.number().optional(),
      Enabled: z.boolean().default(true),
    })
    .strict()
    .describe("Use when class=ScreenGui. Full-screen GUI container for HUD and menu elements."),
  z
    .object({
      AfterBounceAngularMultiply: z
        .number()
        .describe("Multiplier for angular velocity from contact friction after a bounce. 1.0 = 100%.")
        .optional(),
      BPStaticStepAheadSteps: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Static simulation steps covered by one broad-phase AABB.")
        .optional(),
      BallMeshCollisionProfile: z.string().optional(),
      BallRadius: z.number().min(1).describe("Collision radius in cm.").optional(),
      BallSimParams: ballSimParams.optional(),
      BeforeBounceAngularRetention: z
        .number()
        .describe("Fraction of pre-bounce angular velocity retained after impact.")
        .optional(),
      CFrame: cframe.optional(),
      Color: rgb.optional(),
      DetectBounceThreshold: z
        .number()
        .describe("Normal impulse separating a bounce from a sliding contact.")
        .optional(),
      EnablePathMarker: z.boolean().optional(),
      Material: materialEnum.optional(),
      MaterialVariant: z.string().optional(),
      MaxAllowedImpulse: z.number().describe("Cap on normal impulse during collision response.").optional(),
      MicroBounceThresholdMult: z.number().optional(),
      PathMarkerScale: z.number().min(0.01).max(100).optional(),
      PivotOffsetCFrame: cframe.optional(),
      RestingMovementEpsilon: z
        .number()
        .min(0)
        .describe("Max per-frame movement in cm still counted as resting.")
        .optional(),
      RestingSpinSpeedThreshold: z
        .number()
        .min(0)
        .describe("Spin speed in RPM below which resting spin snaps to zero.")
        .optional(),
      RestingToSleepingFrameThreshold: z
        .number()
        .int()
        .min(1)
        .max(255)
        .describe("Resting frames required before angular velocity snaps to zero.")
        .optional(),
      SameSurfaceNormalDegree: z
        .number()
        .min(0)
        .max(60)
        .describe("Max normal angle in degrees for treating two contacts as one surface.")
        .optional(),
      SimulationTraceChannel: traceChannelEnum.describe("Trace channel for static collision sweeps.").optional(),
      SlomoFactor: z.number().min(0.001).describe("Preview playback speed multiplier; 1.0 is normal speed.").optional(),
      TargetRadius: z.number().describe("Target hit radius in cm for trajectory-to-target tests.").optional(),
      TextureId: z.string().describe("Texture asset ID").optional(),
      Transparency: z.number().min(0).max(1).describe("(0~1)").optional(),
      bEnableBroadPhase: z
        .boolean()
        .describe("Skip expensive sweeps when broad-phase AABB finds no candidates.")
        .optional(),
      bEnableMicroBounceRemoval: z.boolean().describe("Remove micro-bounces on low-speed ground contacts.").optional(),
      bKeepPassedMarkers: z.boolean().describe("Keep markers for the already-played path visible.").optional(),
      bPausedWhenSleeping: z.boolean().describe("Pause playback when the simulation snapshot is sleeping.").optional(),
      bTraceComplex: z.boolean().describe("Use complex triangle-mesh collision instead of simple shapes.").optional(),
      bUseRestingContactToSleep: z
        .boolean()
        .describe("Let near-static ground contacts put the ball to sleep.")
        .optional(),
    })
    .strict()
    .describe("Use when class=SimulationBall. Physics-simulated ball with trajectory and path marker."),
  z
    .object({
      Volume: z.number().describe("multiplier (0~10)").default(1),
    })
    .strict()
    .describe("Use when class=SoundGroup. Groups Sounds under a shared volume multiplier."),
  z
    .object({
      Shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
      CFrame: cframe.optional(),
      Size: vec3.describe("units in cm").optional(),
      Anchored: z.boolean().default(true),
      AssemblyLinearVelocity: vec3.optional(),
      CanClimb: z.boolean().optional(),
      CanCollide: z.boolean().default(true),
      CanQuery: z.boolean().default(true),
      CanTouch: z.boolean().default(true),
      CastShadow: z.boolean().optional(),
      CollisionProfile: z.string().describe('e.g. "BlockAll"').optional(),
      Color: rgb.optional(),
      CustomPhysicalProperties: physicalProperties.optional(),
      Enabled: z.boolean().optional(),
      Locked: z.boolean().optional(),
      Material: materialEnum.optional(),
      MaterialVariant: z.string().optional(),
      Neutral: z.boolean().optional(),
      PivotOffsetCFrame: cframe.optional(),
      TeamColor: brickColor.optional(),
      TraceGroupNameString: z.string().optional(),
      Transparency: z.number().describe("(0~1)").optional(),
    })
    .strict()
    .describe("Use when class=SpawnLocation. Player spawn point. Inherits all Part physics/collision properties."),
  z
    .object({
      AspectRatio: z.number().optional(),
      AspectType: z.string().describe('e.g. "FitWithinMaxSize"').optional(),
      DominantAxis: z.string().describe('e.g. "Width"').optional(),
    })
    .strict()
    .describe("Use when class=UIAspectRatioConstraint. Locks the aspect ratio of a sibling UI element."),
  z
    .object({
      KeyboardKeyCode: z.string().describe('e.g. "E"'),
      UIOffset: z.object({ X: z.number(), Y: z.number() }).optional(),
      ActionText: z.string(),
      AutoLocalize: z.boolean().default(true),
      ClickablePrompt: z.boolean().default(true),
      Enabled: z.boolean().default(true),
      Exclusivity: z.enum(["OnePerButton", "OneGlobally", "AlwaysShow"]).optional(),
      HoldDuration: z.number().default(0),
      MaxActivationDistance: z.number().default(200),
      ObjectText: z.string(),
      RequiresLineOfSight: z.boolean().default(true),
    })
    .strict()
    .describe("Use when class=ProximityPrompt. Nearby interaction prompt triggered when a player approaches."),
  z
    .object({
      ApplyStrokeMode: z
        .enum(["Contextual", "Border"])
        .describe("Contextual is only valid on text elements (TextLabel/TextButton); use Border otherwise")
        .optional(),
      BorderOffset: udim.describe("Stroke offset from the border (UDim); Border mode only").optional(),
      BorderStrokePosition: z.enum(["Inner", "Center", "Outer"]).describe("Border mode only").optional(),
      Color: rgb.optional(),
      Enabled: z.boolean().default(true),
      LineJoinMode: z.enum(["Round", "Bevel", "Miter"]).optional(),
      StrokeSizingMode: z.enum(["FixedSize", "ScaledSize"]).optional(),
      Thickness: z.number().default(1),
      Transparency: z.number().describe("(0~1)").optional(),
      ZIndex: z
        .number()
        .describe("Display priority vs other overlapping UIStrokes (not general GUI ZIndex); Border mode only")
        .optional(),
    })
    .strict()
    .describe(
      "Use when class=UIStroke. Applies an outline stroke to the parent GuiObject's border or text with configurable color, thickness, and join style.",
    ),
  z
    .object({})
    .strict()
    .describe("Use when class=ActionSequence. The sequence payload is owned by the Action Sequencer editor."),
  z
    .object({
      Axis: vec3.optional(),
      CFrame: cframe.optional(),
      SecondaryAxis: vec3.optional(),
      Transform: cframe.describe("Current animated offset of the bone in its local space.").optional(),
      WorldAxis: vec3.describe("Unit direction of the bone's X axis in world space.").optional(),
      WorldCFrame: cframe.optional(),
      WorldSecondaryAxis: vec3.describe("Unit direction of the bone's Y axis in world space.").optional(),
    })
    .strict()
    .describe("Use when class=Bone. A named transform node inside a Skeleton."),
  z
    .object({ Enabled: z.boolean().describe("Toggles whether the constraint is active.").optional() })
    .strict()
    .describe("Use when class=Constraint. Base physics constraint between two Attachments."),
  z
    .object({
      AirControl: z.number().min(0).max(1).optional(),
      AutomaticScalingEnabled: z
        .boolean()
        .describe("Scale the character to the HumanoidDescription values.")
        .optional(),
      BreakJointsOnDeath: z.boolean().optional(),
      CameraOffset: vec3.optional(),
      CapsuleHeight: z.number().min(0).optional(),
      CapsuleRadius: z.number().min(0).optional(),
      CharacterMeshPos: vec3.optional(),
      DisplayDistanceType: z
        .enum(["Viewer", "Subject", "None"])
        .describe("Distance behaviour of the name and health display.")
        .optional(),
      FallingDeceleration: z.number().min(0).optional(),
      FallingLateralFriction: z.number().min(0).optional(),
      GravityScale: z.number().min(0).optional(),
      GroundFriction: z.number().min(0).optional(),
      Health: z.number().optional(),
      IgnoreBaseRotation: z.boolean().optional(),
      Jump: z.boolean().optional(),
      JumpHeight: z.number().optional(),
      JumpPower: z.number().optional(),
      LookCameraDirection: z.boolean().optional(),
      MaxAcceleration: z.number().min(0).optional(),
      MaxHealth: z.number().optional(),
      MaxJumpCount: z.number().int().min(0).optional(),
      MaxSlopeAngle: z.number().min(0).max(90).optional(),
      NameDisplayDistance: z.number().optional(),
      RequiresNeck: z.boolean().optional(),
      RotationSpeed: z.number().min(0).optional(),
      StompJumpMultiplier: z.number().optional(),
      TargetPoint: vec3.optional(),
      UseJumpPower: z.boolean().optional(),
      WalkSpeed: z.number().optional(),
      WalkingDeceleration: z.number().min(0).optional(),
    })
    .strict()
    .describe("Use when class=Humanoid. Character controller: health, movement, jumping and camera behaviour."),
  z
    .object({ Enabled: z.boolean().optional(), Source: z.string().optional() })
    .strict()
    .describe("Use when class=LocalScript. Lua script that runs on the client."),
  z
    .object({ Source: z.string().optional() })
    .strict()
    .describe("Use when class=ModuleScript. Reusable Lua module returned to require()."),
  z
    .object({
      ArcSize: z.number().min(0).max(360).describe("Clockwise/CounterClockwise fill only").optional(),
      CornerClipEnabled: z.boolean().optional(),
      FillColor3: rgb.optional(),
      FillCornerRadius: udim.optional(),
      FillDirection: z
        .enum([
          "LeftToRight",
          "RightToLeft",
          "TopToBottom",
          "BottomToTop",
          "CenterHorizontal",
          "CenterVertical",
          "Clockwise",
          "CounterClockwise",
        ])
        .optional(),
      FillImage: z.string().describe("Image asset ID").optional(),
      FillTransparency: z.number().min(0).max(1).describe("(0~1)").optional(),
      StartAngle: z.number().min(0).max(360).describe("Clockwise/CounterClockwise fill only").optional(),
      TrackColor3: rgb.optional(),
      TrackCornerRadius: udim.optional(),
      TrackImage: z.string().describe("Image asset ID").optional(),
      TrackTransparency: z.number().min(0).max(1).describe("(0~1)").optional(),
      Value: z.number().min(0).max(1).describe("Fill amount (0~1)").optional(),
      ...guiObjectProperties,
    })
    .strict()
    .describe(
      "Use when class=ProgressBar. GUI progress bar with separately styled track and fill, supporting linear and radial fill directions.",
    ),
  z
    .object({ Enabled: z.boolean().optional(), Source: z.string().optional() })
    .strict()
    .describe("Use when class=Script. Lua script that runs on the server."),
  z
    .object({ PivotOffsetCFrame: cframe.optional(), SkeletonId: z.string().optional() })
    .strict()
    .describe("Use when class=Skeleton. Bone hierarchy driving a skinned mesh."),
  z
    .object({ TeamColor: brickColor.optional() })
    .strict()
    .describe("Use when class=Team. Player team identified by its BrickColor."),
  z
    .object({
      FillDirection: z.enum(["Horizontal", "Vertical"]).optional(),
      HorizontalAlignment: z.enum(["Center", "Left", "Right"]).optional(),
      SortOrder: z.enum(["Name", "LayoutOrder"]).optional(),
      VerticalAlignment: z.enum(["Center", "Top", "Bottom"]).optional(),
    })
    .strict()
    .describe("Use when class=UIGridStyleLayout. Shared layout controls for grid and list layouts."),
  z
    .object({ Order: z.number().int().optional() })
    .strict()
    .describe("Use when class=WrapLayer. Clothing wrap layer ordering."),
  workspaceServiceSchema,
  lightingServiceSchema,
  atmosphereServiceSchema,
  playersServiceSchema,
  starterPlayerServiceSchema,
  materialServiceSchema,
]);

// The union's first `instanceClassEnum.options.length` members are the instance-class schemas (same
// order as the enum); the remainder are service schemas. Inject the universal base-Instance
// properties into the instance-class members only.
const instanceClassCount = instanceClassEnum.options.length;
export const instancePropertiesSchema = z
  .union(
    rawInstancePropertiesUnion.options.map((option, index) =>
      index < instanceClassCount && option instanceof z.ZodObject ? option.extend(instanceBaseProperties) : option,
    ) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  )
  .optional();

/** Explicit service-class — schema entries (not index-dependent). */
const serviceSchemaEntries: [string, z.ZodTypeAny][] = [
  ["Workspace", workspaceServiceSchema],
  ["Lighting", lightingServiceSchema],
  ["Atmosphere", atmosphereServiceSchema],
  ["Players", playersServiceSchema],
  ["StarterPlayer", starterPlayerServiceSchema],
  ["MaterialService", materialServiceSchema],
  ["HttpService", emptyServiceSchema],
  ["CollectionService", emptyServiceSchema],
  ["DataModel", emptyServiceSchema],
  ["DataStoreService", emptyServiceSchema],
  ["PhysicsService", emptyServiceSchema],
  ["RunService", emptyServiceSchema],
  ["ServerScriptService", emptyServiceSchema],
  ["ServerStorage", emptyServiceSchema],
  ["StarterCharacterScripts", emptyServiceSchema],
  ["StarterGui", emptyServiceSchema],
  ["StarterPlayerScripts", emptyServiceSchema],
  ["ReplicatedStorage", emptyServiceSchema],
];

/** Map from instance/service class name to its dedicated property schema. */
export const classPropertiesSchemas: ReadonlyMap<string, z.ZodTypeAny> = new Map([
  ...instanceClassEnum.options.map((name, i) => {
    const inner = instancePropertiesSchema as z.ZodOptional<z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>>;
    return [name, inner.unwrap().options[i]] as [string, z.ZodTypeAny];
  }),
  ...serviceSchemaEntries,
]);

// Shape spec for deep-stripping unknown keys when reading .ovdrjm nodes.
// `true` = keep the value as-is (primitive). Object = recurse and strip unknown keys.
// When the actual value is an array, the shape is applied to each element.
export type ShapeSpec = true | { readonly [key: string]: ShapeSpec };

/** Derive a ShapeSpec from a Zod schema by unwrapping wrappers and recursing into objects. */
function zodToShape(schema: z.ZodTypeAny): ShapeSpec {
  if (schema instanceof z.ZodObject) {
    const result: Record<string, ShapeSpec> = {};
    for (const [key, val] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      result[key] = zodToShape(val);
    }
    return result;
  }
  if (schema instanceof z.ZodOptional) return zodToShape(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToShape(schema.removeDefault());
  if (schema instanceof z.ZodArray) return zodToShape(schema.element);
  if (schema instanceof z.ZodEffects) return zodToShape(schema.innerType());
  return true;
}

export const classPropertyShapes: Record<string, Record<string, ShapeSpec>> = Object.fromEntries(
  [...classPropertiesSchemas.entries()].map(([name, schema]) => [
    name,
    zodToShape(schema) as Record<string, ShapeSpec>,
  ]),
);
