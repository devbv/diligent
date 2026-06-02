// @summary Defines shared instance property schemas and class enums for Studio RPC tools.
import { z } from "zod";

const vec3 = z.object({ X: z.number(), Y: z.number(), Z: z.number() });
const udim = z.object({ Scale: z.number(), Offset: z.number() });
const colorChannel = z.number().int().min(0).max(255);
const rgb = z.object({ R: colorChannel, G: colorChannel, B: colorChannel });
const udim2 = z.object({
  X: z.object({ Scale: z.number(), Offset: z.number() }),
  Y: z.object({ Scale: z.number(), Offset: z.number() }),
});

const normalIdEnum = z.enum(["Right", "Top", "Back", "Left", "Bottom", "Front"]);
const colorSequence = z
  .array(z.object({ Time: z.number(), Color: rgb }))
  .describe("ColorSequence keypoints [{Time,Color}]");
const numberSequence = z
  .array(z.object({ Time: z.number(), Value: z.number(), Envelope: z.number().optional() }))
  .describe("NumberSequence keypoints [{Time,Value,Envelope?}]");
const numberRange = z.object({ Min: z.number(), Max: z.number() });
const surfaceGuiBaseProperties = {
  Active: z.boolean().default(true),
  AlwaysOnTop: z.boolean().optional(),
  Brightness: z.number().default(10),
  ClipsDescendants: z.boolean().default(true),
  Enabled: z.boolean().default(true),
  LightInfluence: z.number().describe("(0~1)").default(1),
  MaxDistance: z.number().default(3000),
  Size: udim2.describe("UI size (UDim2)").optional(),
  ZIndexBehavior: z.string().describe('e.g. "Sibling"').optional(),
};

const guiObjectProperties = {
  Active: z.boolean().default(true),
  AnchorPoint: z.object({ X: z.number(), Y: z.number() }).optional(),
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
  Bold: z.boolean().optional(),
  Text: z.string().optional(),
  TextColor3: rgb.optional(),
  TextScaled: z.boolean().optional(),
  TextSize: z.number().default(14),
  TextTransparency: z.number().describe("(0~1)").optional(),
  TextWrapped: z.boolean().optional(),
  TextXAlignment: z.string().describe('e.g. "Left"').optional(),
  TextYAlignment: z.string().describe('e.g. "Top"').optional(),
};

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
  "Wood",
  "Neon",
]);

// --- Service property schemas (update-only, not insertable) ---

const workspaceServiceSchema = z
  .object({
    Gravity: z.number().optional(),
    HitboxType: z.string().describe('e.g. "Single"').optional(),
  })
  .strict()
  .describe("Use when updating Workspace service. Controls world gravity and hitbox type.");

const lightingServiceSchema = z
  .object({
    AmbientSkyBrightness: z.number().optional(),
    AmbientSkyColor: rgb.optional(),
    AutoTimeCycle: z.number().optional(),
    ClockTime: z.number().optional(),
    Contrast: z.number().optional(),
    GroundReflectionColor: rgb.optional(),
    MoonBrightness: z.number().optional(),
    MoonCastShadow: z.boolean().optional(),
    MoonLightColor: rgb.optional(),
    MoonMaterialColor: rgb.optional(),
    MoonMaxHeight: z.number().optional(),
    MoonPathAngle: z.number().optional(),
    MoonPhase: z.number().optional(),
    NightBrightness: z.number().optional(),
    RealTimeDayDuration: z.number().optional(),
    Saturation: z.number().optional(),
    SkyColorInfluence: z.number().optional(),
    StarsBrightness: z.number().optional(),
    StarsColor: rgb.optional(),
    SunBrightness: z.number().optional(),
    SunCastShadow: z.number().optional(),
    SunLightColor: rgb.optional(),
    SunMaxHeight: z.number().optional(),
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
    AllowCustomAnimations: z.number().optional(),
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
        "AsphaltName",
        "BarkName",
        "BasicName",
        "BeigeTerrazzoFloor",
        "BrickCeramicTile",
        "BrickName",
        "BrokenConcreteName",
        "BrokenRoof",
        "BrushMetal",
        "CementWallName",
        "CheckerTileFloorName",
        "ConcreteName",
        "ConcretePlateName",
        "CopperName",
        "CorrugatedSteelName",
        "CrackedMiddleCeramicTileName",
        "CrackedSmallCeramicTileName",
        "DamagedRoofName",
        "DistroyedBronzeName",
        "EmeraldGridTile",
        "GalvanizedMetal",
        "GlassName",
        "GrassName",
        "GreyWovenFabric",
        "GridBorder",
        "GridBoxName",
        "GridMarbleName",
        "GridPentagonName",
        "GridQuadName",
        "GridTileName",
        "GroundName",
        "HalfLeafyGroundName",
        "HouseBricksName",
        "IndustrialRibbedSteel",
        "LeafyGroundName",
        "MarbleName",
        "MetalName",
        "MetalPlateName",
        "MixRoadName",
        "MosaicCarpetName",
        "MossyGroundName",
        "MossyRockName",
        "OceanPanelTile",
        "OfficeCeilingWhiteName",
        "PaintedMetal",
        "PaintedWood",
        "PavingBlockName",
        "PavingBrickName",
        "PavingFloorName",
        "PavingName",
        "PavingStonesName",
        "PavingWallName",
        "PeelingPaintSteel",
        "PlankName",
        "PlasticName",
        "RoadName",
        "RockName",
        "RoofName",
        "RustBrassName",
        "RustName",
        "RustySteel",
        "SandName",
        "SandstoneBrick",
        "SilverMetalName",
        "SmallBrickName",
        "SnowName",
        "SoilRockGroundName",
        "SquareCeramicTile",
        "StoneBrickName",
        "StoneFloorName",
        "TakenOffCeramicTileName",
        "TerrazzoFloorName",
        "ThickCarpet",
        "UnlitName",
        "UrbanSlateFloor",
        "WeatheredPlasterBrick",
        "WhiteCementBrick",
        "WhiteGrayBrickName",
        "WoodName",
      ].map((n) => [n, z.string().optional()]),
    ) as Record<string, z.ZodOptional<z.ZodString>>,
  )
  .strict()
  .describe("Use when updating MaterialService. Each property maps a base material to its custom variant name.");

const httpServiceSchema = z
  .object({
    HttpEnabled: z.boolean().optional(),
  })
  .strict()
  .describe("Use when updating HttpService. Controls whether HTTP requests are enabled.");

const emptyServiceSchema = z.object({}).strict();

export const instancePropertiesSchema = z
  .union([
    z
      .object({
        Shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        Size: vec3.describe("units in cm").optional(),
        Anchored: z.boolean().default(true),
        CanCollide: z.boolean().default(true),
        CanQuery: z.boolean().default(true),
        CanTouch: z.boolean().default(true),
        CastShadow: z.boolean().optional(),
        CollisionGroup: z.string().optional(),
        Color: rgb.optional(),
        Locked: z.boolean().optional(),
        Mass: z.number().optional(),
        Massless: z.boolean().optional(),
        Material: materialEnum.optional(),
        MaterialVariant: z.string().optional(),
        Reflectance: z.number().describe("(0~1)").optional(),
        RootPriority: z.number().optional(),
        Transparency: z.number().describe("(0~1)").optional(),
      })
      .strict()
      .describe("Use when class=Part. A 3D primitive shape (Block, Ball, Cylinder) with physics and collision."),
    z
      .object({
        Color: rgb.optional(),
        Thickness: z.number().optional(),
        Adornee: z.string().describe("InstanceGuid of the target instance to outline").optional(),
        Enabled: z.boolean().optional(),
      })
      .strict()
      .describe("Use when class=Outline. Overlay effect with edge color/thickness around an adornee instance."),
    z
      .object({
        Color: rgb.optional(),
        DepthMode: z.enum(["AlwaysOnTop", "VisibleWhenNotOccluded", "VisibleWhenOccluded"]).optional(),
        Transparency: z.number().describe("(0~1)").optional(),
        Adornee: z.string().describe("InstanceGuid of the target instance to fill").optional(),
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
        ...guiObjectProperties,
      })
      .strict()
      .describe("Use when class=ImageButton. Clickable GUI element that displays an image with press/hover states."),
    z
      .object({
        Image: z.string().describe("Image asset ID").optional(),
        ImageColor3: rgb.optional(),
        ImageTransparency: z.number().describe("(0~1)").optional(),
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
        Volume: z.number().describe("multiplier (0~10)").default(1),
        Looped: z.boolean().optional(),
        PlaybackSpeed: z.number().default(1),
        PlayOnRemove: z.boolean().optional(),
        RollOffMaxDistance: z.number().default(5000),
        RollOffMinDistance: z.number().default(10),
        RollOffMode: z.string().describe('e.g. "InverseTapered"').optional(),
        StartTimePosition: z.number().optional(),
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
        ManualActivationOnly: z.boolean().optional(),
        RequiresHandle: z.boolean().optional(),
        ToolTip: z.string().optional(),
      })
      .strict()
      .describe("Use when class=Tool. An equippable item a player can pick up and activate."),
    z
      .object({
        PresetName: z.string(),
        Color: z.array(z.object({ Time: z.number(), R: z.number(), G: z.number(), B: z.number() })),
        Enabled: z.boolean().default(true),
        InfiniteLoop: z.boolean().default(true),
        LoopCount: z.number().default(1),
        Size: z.number().default(1),
        Transparency: z.number().describe("(0~1)").optional(),
      })
      .strict()
      .describe("Use when class=VFXPreset. A named visual effects preset for quick particle effect setup."),
    z
      .object({
        AngularVelocity: vec3.optional(),
        Enabled: z.boolean().default(true),
        MaxTorque: z.number().default(1000),
        ReactionTorqueEnabled: z.boolean().optional(),
        RelativeTo: z.string().describe('e.g. "World"').optional(),
        Visible: z.boolean().optional(),
      })
      .strict()
      .describe("Use when class=AngularVelocity. Applies a target rotational velocity to a physics body."),
    z
      .object({
        VelocityConstraintMode: z.string().describe('e.g. "Vector"').optional(),
        VectorVelocity: vec3.optional(),
        LineDirection: vec3.optional(),
        LineVelocity: z.number().optional(),
        PlaneVelocity: z.object({ X: z.number(), Y: z.number() }).optional(),
        PrimaryTangentAxis: vec3.optional(),
        SecondaryTangentAxis: vec3.optional(),
        Enabled: z.boolean().default(true),
        ForceLimitsEnabled: z.boolean().default(true),
        ForceLimitMode: z.string().describe('e.g. "Magnitude"').optional(),
        MaxForce: z.number().default(10),
        MaxAxesForce: vec3.optional(),
        RelativeTo: z.string().describe('e.g. "World"').optional(),
        Visible: z.boolean().optional(),
      })
      .strict()
      .describe(
        "Use when class=LinearVelocity. Applies a target linear velocity to a physics body via Vector, Line, or Plane mode.",
      ),
    z
      .object({
        Force: vec3.optional(),
        ApplyAtCenterOfMass: z.boolean().optional(),
        Enabled: z.boolean().default(true),
        RelativeTo: z.string().describe('e.g. "World"').optional(),
        Visible: z.boolean().optional(),
      })
      .strict()
      .describe(
        "Use when class=VectorForce. Applies a constant force vector to a physics body, optionally at its center of mass.",
      ),
    z
      .object({
        PrimaryPart: z.string().describe("InstanceGuid of the primary part").optional(),
        WorldPivot: z.object({ Position: vec3, Orientation: vec3 }).optional(),
      })
      .strict()
      .describe(
        "Use when class=Model. Groups BaseParts into a single unit; supports physics, movement, and rotation as one entity.",
      ),
    z
      .object({})
      .strict()
      .describe(
        "Use when class=Folder. Logical organizer with no properties — use for grouping scripts or non-physical instances.",
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
        SizeOffset: z
          .object({ X: z.number(), Y: z.number() })
          .describe("Screen-space size offset (Vector2)")
          .optional(),
      })
      .strict()
      .describe("Use when class=BillboardGui. World-space GUI that always faces the camera, anchored to an Adornee."),
    z
      .object({
        ...surfaceGuiBaseProperties,
        Face: normalIdEnum.optional(),
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
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        SecondaryAxis: vec3.optional(),
      })
      .strict()
      .describe(
        "Use when class=Attachment. Defines a local coordinate frame on a BasePart for constraints and effects.",
      ),
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
        LifeTime: numberRange.optional(),
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
        Shadows: z.boolean().optional(),
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
        Shadows: z.boolean().optional(),
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
        Shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        Size: vec3.describe("units in cm").optional(),
        Anchored: z.boolean().default(true),
        CanCollide: z.boolean().default(true),
        CanQuery: z.boolean().default(true),
        CanTouch: z.boolean().default(true),
        CastShadow: z.boolean().optional(),
        CollisionGroup: z.string().optional(),
        Color: rgb.optional(),
        DoubleSided: z.boolean().optional(),
        EnableMeshShadowDetails: z.boolean().optional(),
        Locked: z.boolean().optional(),
        Massless: z.boolean().optional(),
        Material: materialEnum.optional(),
        MaterialVariant: z.string().optional(),
        MeshId: z.string().describe("Mesh asset ID").optional(),
        Reflectance: z.number().describe("(0~1)").optional(),
        RootPriority: z.number().optional(),
        TextureId: z.string().describe("Surface texture asset ID").optional(),
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
      })
      .strict()
      .describe(
        "Use when class=HumanoidDescription. Defines a character's full appearance including body parts, animations, and accessories.",
      ),
    z
      .object({
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        CameraOffset: vec3.optional(),
        CameraSubject: z.string().describe("InstanceGuid of the subject to follow").optional(),
        CameraType: z
          .enum(["Fixed", "Attach", "Watch", "Track", "Follow", "Custom", "Scriptable", "Orbital"])
          .optional(),
        EnableSmoothFollow: z.boolean().optional(),
        EnableSmoothRotation: z.boolean().optional(),
        FieldOfView: z.number().optional(),
        Focus: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        FollowMaxDistance: z.number().optional(),
        SmoothFollowSpeed: z.number().optional(),
        SmoothRotationSpeed: z.number().optional(),
      })
      .strict()
      .describe("Use when class=Camera. Controls the world camera view and behavior."),
    z
      .object({
        BaseMaterial: materialEnum.optional(),
        Color: rgb.optional(),
        ColorMap: z.string().describe("Texture asset ID").optional(),
        Emissive: rgb.optional(),
        EmissiveIntensity: z.number().optional(),
        EmissiveMap: z.string().describe("Texture asset ID").optional(),
        Metalness: z.number().describe("(0~1)").optional(),
        MetalnessMap: z.string().describe("Texture asset ID").optional(),
        MetersPerTile: z.number().optional(),
        NormalMap: z.string().describe("Texture asset ID").optional(),
        Roughness: z.number().describe("(0~1)").optional(),
        RoughnessMap: z.string().describe("Texture asset ID").optional(),
      })
      .strict()
      .describe("Use when class=MaterialVariant. Custom material override with PBR texture maps and surface color."),
    z
      .object({
        DisplayOrder: z.number().optional(),
        Enabled: z.boolean().default(true),
      })
      .strict()
      .describe("Use when class=ScreenGui. Full-screen GUI container for HUD and menu elements."),
    z
      .object({
        BallRadius: z.number().optional(),
        BallState: z.string().describe('e.g. "Idle"').optional(),
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        Color: rgb.optional(),
        EnablePathMarker: z.boolean().optional(),
        IsPathMarkerWorldSpace: z.boolean().optional(),
        Material: materialEnum.optional(),
        MaterialVariant: z.string().optional(),
        PathMarkerScale: z.number().optional(),
        SlomoFactor: z.number().optional(),
        TextureId: z.string().describe("Texture asset ID").optional(),
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
        CFrame: z.object({ Position: vec3, Orientation: vec3 }).optional(),
        Size: vec3.describe("units in cm").optional(),
        Anchored: z.boolean().default(true),
        CanCollide: z.boolean().default(true),
        CanQuery: z.boolean().default(true),
        CanTouch: z.boolean().default(true),
        CastShadow: z.boolean().optional(),
        CollisionGroup: z.string().optional(),
        Color: rgb.optional(),
        Locked: z.boolean().optional(),
        Mass: z.number().optional(),
        Massless: z.boolean().optional(),
        Material: materialEnum.optional(),
        MaterialVariant: z.string().optional(),
        Reflectance: z.number().describe("(0~1)").optional(),
        RootPriority: z.number().optional(),
        Transparency: z.number().describe("(0~1)").optional(),
        Enabled: z.boolean().optional(),
        Neutral: z.boolean().optional(),
        TeamColor: rgb.optional(),
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
        Exclusivity: z.enum(["OnePerButton", "OneGlobally", "AlwaysShow"]).optional(),
        HoldDuration: z.number().default(0),
        MaxActivationDistance: z.number().default(200),
        ObjectText: z.string(),
        ActionText: z.string(),
        ClickablePrompt: z.boolean().default(true),
        Enabled: z.boolean().default(true),
        RequiresLineOfSight: z.boolean().default(true),
      })
      .strict()
      .describe("Use when class=ProximityPrompt. Nearby interaction prompt triggered when a player approaches."),
    workspaceServiceSchema,
    lightingServiceSchema,
    atmosphereServiceSchema,
    playersServiceSchema,
    starterPlayerServiceSchema,
    materialServiceSchema,
    httpServiceSchema,
  ])
  .optional();

/** Explicit service-class → schema entries (not index-dependent). */
const serviceSchemaEntries: [string, z.ZodTypeAny][] = [
  ["Workspace", workspaceServiceSchema],
  ["Lighting", lightingServiceSchema],
  ["Atmosphere", atmosphereServiceSchema],
  ["Players", playersServiceSchema],
  ["StarterPlayer", starterPlayerServiceSchema],
  ["MaterialService", materialServiceSchema],
  ["HttpService", httpServiceSchema],
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
  return true;
}

export const classPropertyShapes: Record<string, Record<string, ShapeSpec>> = Object.fromEntries(
  [...classPropertiesSchemas.entries()].map(([name, schema]) => [
    name,
    zodToShape(schema) as Record<string, ShapeSpec>,
  ]),
);
