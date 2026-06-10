--#METADATA#{"CREATABLE_INSTANCES": ["ActionRunner", "ActionSequence", "ActionSequenceService", "AngularVelocity", "Animation", "AnimationTrack", "Animator", "Atmosphere", "Attachment", "Backpack", "BackpackItem", "BasePart", "BaseScript", "Beam", "BillboardGui", "BindableEvent", "Bone", "BoolValue", "Camera", "CharacterMesh", "CollectionService", "Constraint", "ContextActionService", "CoreGui", "DataModel", "DataStore", "DataStoreGetOptions", "DataStoreIncrementOptions", "DataStoreInfo", "DataStoreKeyInfo", "DataStoreKeyPages", "DataStoreListingPages", "DataStoreService", "DataStoreSetOptions", "Fill", "Folder", "FormFactorPart", "Frame", "GenericSettings", "GlobalDataStore", "GuiBase2d", "GuiButton", "GuiObject", "HttpService", "Humanoid", "HumanoidDescription", "ImageButton", "ImageLabel", "InputObject", "Instance", "IntValue", "LayerCollector", "Light", "Lighting", "LinearVelocity", "LocalScript", "LocalizationService", "LuaSourceContainer", "MarketplaceService", "MaterialService", "MaterialVariant", "MeshPart", "Model", "ModuleScript", "Mouse", "NumberValue", "OrderedDataStore", "Outline", "OverlayBase", "PVInstance", "Pages", "Part", "ParticleEmitter", "PhysicsService", "Player", "PlayerGui", "PlayerScripts", "Players", "PointLight", "ProximityPrompt", "ProximityPromptService", "RemoteEvent", "ReplicatedStorage", "RunService", "ScreenGui", "Script", "ScrollingFrame", "ServerScriptService", "ServerStorage", "ServiceProvider", "SimulationBall", "Skeleton", "Sound", "SoundGroup", "SoundService", "SpawnLocation", "SpotLight", "StarterCharacterScripts", "StarterGui", "StarterPack", "StarterPlayer", "StarterPlayerScripts", "StringValue", "SurfaceGui", "SurfaceGuiBase", "Team", "Teams", "TeleportAsyncResult", "TeleportOptions", "TeleportService", "TextButton", "TextLabel", "Tool", "Trail", "Translator", "Tween", "TweenBase", "TweenService", "UIAspectRatioConstraint", "UIGridLayout", "UIGridStyleLayout", "UIListLayout", "UserGameSettings", "UserInputService", "UserSettings", "VFXPreset", "ValueBase", "VectorForce", "Workspace", "WorldRankService", "WorldRoot", "WrapLayer", "WrapTarget"], "SERVICES": ["ActionSequenceService", "CollectionService", "ContextActionService", "DataStoreService", "HttpService", "Lighting", "LocalizationService", "MarketplaceService", "MaterialService", "PhysicsService", "Players", "ProximityPromptService", "ReplicatedStorage", "RunService", "ServerScriptService", "ServerStorage", "SoundService", "TeleportService", "TweenService", "UserInputService", "Workspace", "WorldRankService"]}
-- Overdare API Type Definitions
-- Auto-generated on 2026-06-10 18:37:00
-- DO NOT EDIT MANUALLY

-- Event Types
type ScriptConnection = {
	Disconnect: (self: ScriptConnection) -> ()
}

-- Data Types
declare class ScriptSignal
	function Connect(self, func: (...any) -> ()): ScriptConnection
	function Once(self, func: (...any) -> ()): ScriptConnection
	function Wait(self): any
end

declare class NumberSequenceKeypoint
	Envelope: number
	Time: number
	Value: number
end

declare NumberSequenceKeypoint: {
	new: (InTime: number, InValue: number) -> NumberSequenceKeypoint,
	new: (InTime: number, InValue: number, InEnvelope: number) -> NumberSequenceKeypoint,
}

declare class NumberSequence
	Keypoints: {any}
end

declare NumberSequence: {
	new: (InValue: number) -> NumberSequence,
	new: (InArrayValue: table) -> NumberSequence,
	new: (n0: number, n1: number) -> NumberSequence,
}

declare class Color3
	B: number
	G: number
	R: number
end

declare Color3: {
	fromRGB: (red: number, green: number, blue: number) -> Color3,
	new: (red: number, green: number, blue: number) -> Color3,
}

declare class PredictProjectilePathParams
	DrawDebugTime: number
	InstancesToIgnore: {any}
	LaunchVelocity: Vector3
	MaxSimTime: number
	OverrideGravityZ: number
	ProjectileRadius: number
	SimFrequency: number
	StartLocation: Vector3
	TraceChannel: CollisionChannel
	TraceComplex: boolean
	TraceWithChannel: boolean
	TraceWithCollision: boolean
	function AddIgnoredInstanceToArray(self, Instance: Instance): boolean
	function RemoveIgnoredInstanceFromArray(self, Instance: Instance): boolean
end

declare PredictProjectilePathParams: {
	new: () -> any,
}

declare class Content
	Content: string
end

declare class EnumItem
	Name: string
	Value: number
	EnumType: Enum
end

declare class BallSnapshot
	CFrame: CFrame
	Direction: Vector3
	hitCount: number
	HitLastIndex: number
	HitStartIndex: number
	Speed: number
	SpinAxis: Vector3
	SpinSpeed: number
end

declare class BrickColor
	b: number
	Color: Color3
	g: number
	Name: string
	Number: number
	r: number
end

declare BrickColor: {
	new: (val: string) -> BrickColor,
}

declare class Enum
	function GetEnumItems(self): {any}
end

declare class CollisionResponseParams
	ResponseArray: {any}
	function AddResponseToArray(self, Channel: CollisionChannel, Response: CollisionResponse): any
	function RemoveAllResponses(self): any
	function RemoveReponseFromArray(self, InChannel: CollisionChannel): any
end

declare CollisionResponseParams: {
	new: () -> any,
}

declare class RaycastParams
	BruteForceAllSlow: boolean
	FilterDescendantsInstances: {any}
	FilterType: RaycastFilterType
	FindInitialOverlaps: boolean
	IgnoreWater: boolean
	RespectCanCollide: boolean
	TraceComplex: boolean
	function AddToFilter(self, InValue: any): RaycastParams
end

declare RaycastParams: {
	new: () -> RaycastParams,
}

declare class CollisionQueryParams
	FindInitialOverlaps: boolean
	IgnoreBlocks: boolean
	IgnoreTouches: boolean
	SkipNarrowPhase: boolean
	TraceComplex: boolean
	TraceIntoSubComponents: boolean
end

declare CollisionQueryParams: {
	new: () -> any,
}

declare class UDim
	Offset: number
	Scale: number
end

declare UDim: {
	new: (Scale: number, Offset: number) -> UDim,
}

declare class BallBounce
	AngularVelocity: Vector3
	BouncedAngularVelocity: Vector3
	BouncedDirection: Vector3
	BouncedPosition: Vector3
	BouncedSpeed: number
	BouncedSpin: number
	BouncedTime: number
	CFrame: CFrame
	Direction: Vector3
	ImpactNormal: Vector3
	ImpactPoint: Vector3
	IsSliding: boolean
	Speed: number
	Spin: number
	StartPos: Vector3
end

declare class PredictProjectilePathPointData
	Location: Vector3
	Time: number
	Velocity: Vector3
end

declare class CFrame
	identity: CFrame
	LookVector: Vector3
	Orientation: Vector3
	Position: Vector3
	RightVector: Vector3
	Rotation: CFrame
	UpVector: Vector3
	X: number
	XVector: Vector3
	Y: number
	YVector: Vector3
	Z: number
	ZVector: Vector3
	function FromEulerAnglesXYZ(self, rx: number, ry: number, rz: number): CFrame
	function FromEulerAnglesYXZ(self, rx: number, ry: number, rz: number): CFrame
	function Inverse(self): CFrame
	function Lerp(self, goal: CFrame, alpha: number): CFrame
	function PointToObjectSpace(self, v3: Vector3): Vector3
	function PointToWorldSpace(self, v3: Vector3): Vector3
	function ToEulerAnglesXYZ(self): any
	function ToEulerAnglesYXZ(self): any
	function ToOrientation(self): any
	function VectorToObjectSpace(self, v3: Vector3): Vector3
	function VectorToWorldSpace(self, v3: Vector3): Vector3
end

declare CFrame: {
	Angles: (rx: number, ry: number, rz: number) -> CFrame,
	fromEulerAnglesXYZ: (rx: number, ry: number, rz: number) -> CFrame,
	fromEulerAnglesYXZ: (rx: number, ry: number, rz: number) -> CFrame,
	fromMatrix: (pos: Vector3, vX: Vector3, vY: Vector3, vZ: Vector3?) -> CFrame,
	fromOrientation: (rx: number, ry: number, rz: number) -> CFrame,
	lookAt: (at: Vector3, lookAt: Vector3, up: Vector3?) -> CFrame,
	new: () -> CFrame,
	new: (Position: Vector3) -> CFrame,
	new: (Position: Vector3, Look: Vector3) -> CFrame,
	new: (x: number, y: number, z: number) -> CFrame,
}

declare class BallSimParams
	BaseGravity: number
	DampingAngular: number
	DampingLinear: number
	DeltaTime: number
	EnableGravityFalloff: boolean
	Friction: number
	Gravity: Vector3
	GravityFalloffEndHeight: number
	GravityFalloffStartHeight: number
	InitialCFrame: CFrame
	InitialSpinAxis: Vector3
	InitialSpinSpeed: number
	InitialVelocity: Vector3
	Mass: number
	MinFalloffGravity: number
	Restitution: number
	Simsteps: number
	SpinMagnusWeight: number
end

declare BallSimParams: {
	new: () -> BallSimParams,
}

declare class ColorSequenceKeypoint
	Time: number
	Value: Color3
end

declare ColorSequenceKeypoint: {
	new: (Time: number, color: Color3) -> ColorSequenceKeypoint,
}

declare class PredictProjectilePathResult
	FoundHit: boolean
	HitDistance: number
	HitInstance: Instance
	HitNormal: Vector3
	HitPosition: Vector3
	LastTraceDestination: PredictProjectilePathPointData
	Location: Vector3
	PathDataArray: {any}
	Time: number
end

declare class CollisionObjectQueryParams
	IgnoreMask: number
	ObjectTypesToQuery: number
	function AddObjectTypesToQuery(self, InValue: any): boolean
	function AddObjectTypeToQuery(self, QueryChannel: CollisionChannel): boolean
	function ResetObjectTypes(self): ()
	function ResetObjectTypesAsAllObjects(self): ()
end

declare CollisionObjectQueryParams: {
	new: () -> any,
}

declare class ColorSequence
	Keypoints: {any}
end

declare ColorSequence: {
	new: (color: Color3) -> ColorSequence,
	new: (colorSequenceKeyPoints: table) -> ColorSequence,
	new: (c0: Color3, c1: Color3) -> ColorSequence,
}

declare class Ray
	Direction: Vector3
	Origin: Vector3
	Unit: Ray
	function ClosestPoint(self, InPoint: Vector3): Vector3
	function Distance(self, InPoint: Vector3): number
end

declare Ray: {
	new: (InOrigin: Vector3, InDirection: Vector3) -> Ray,
}

declare class ScriptConnection
	Connected: boolean
	function Disconnect(self): ()
end

declare class Vector3
	Magnitude: number
	one: Vector3
	Unit: Vector3
	X: number
	xAxis: Vector3
	Y: number
	yAxis: Vector3
	Z: number
	zAxis: Vector3
	zero: Vector3
	function Abs(self): Vector3
	function Angle(self, InOtherValue: any, AxisValue: any): number
	function Ceil(self): Vector3
	function ClampMagnitude(self, MaxLength: number): Vector3
	function Cross(self, InOtherValue: any): Vector3
	function Distance(self, OtherValue: Vector3): number
	function Dot(self, InOtherValue: any): number
	function Floor(self): Vector3
	function FuzzyEq(self, InOtherValue: any, Epsilon: number): boolean
	function Lerp(self, GoalValue: Vector3, Alpha: number): Vector3
	function Max(self, OtherValue: Vector3): Vector3
	function Min(self, OtherValue: Vector3): Vector3
	function MoveTowards(self, TargetValue: Vector3, MaxDelta: number): Vector3
	function Reflect(self, NormalValue: Vector3): Vector3
	function Rotate(self, AxisValue: Vector3, Radians: number): Vector3
	function Sign(self): Vector3
	function Slerp(self, GoalValue: Vector3, Alpha: number): Vector3
end

declare Vector3: {
	new: (x: number, y: number, z: number) -> Vector3,
}

declare class UDim2
	X: UDim
	Y: UDim
	function Lerp(self, GoalValue: UDim2, Alpha: number): UDim2
end

declare UDim2: {
	new: (xScale: number, xOffset: number, yScale: number, yOffset: number) -> UDim2,
}

declare class PhysicalProperties
	Density: number
	Elasticity: number
	ElasticityWeight: number
	Friction: number
	FrictionWeight: number
end

declare PhysicalProperties: {
	new: (InMaterial: Material) -> PhysicalProperties,
	new: (InMaterial: number, arg2: number, arg3: number) -> PhysicalProperties,
	new: (InDensity: number, InFriction: number, InElasticity: number, InFrictionWeight: number, InElasticityWeight: number) -> PhysicalProperties,
}

declare class TweenInfo
	DelayTime: number
	EasingDirection: EasingDirection
	EasingStyle: EasingStyle
	RepeatCount: number
	Reverses: boolean
	Time: number
end

declare TweenInfo: {
	new: (InTime: number, InEasingStyle: EasingStyle, InEasingDirection: EasingDirection, InRepeatCount: number, InReverses: boolean, InDelayTime: number) -> TweenInfo,
}

declare class Vector2
	one: Vector2
	X: number
	xAxis: Vector2
	Y: number
	yAxis: Vector2
	zero: Vector2
	function Lerp(self, GoalValue: Vector2, Alpha: number): Vector2
	function Slerp(self, GoalValue: Vector2, Alpha: number): Vector2
end

declare Vector2: {
	new: (x: number, y: number) -> Vector2,
}

declare class OverlapParams
	BruteForceAllSlow: boolean
	FilterDescendantsInstances: {any}
	FilterType: RaycastFilterType
	MaxParts: number
	RespectCanCollide: boolean
	function AddToFilter(self, InValue: any): OverlapParams
end

declare OverlapParams: {
	new: () -> OverlapParams,
}

declare class RaycastResult
	BlockingHit: boolean
	Distance: number
	Instance: Instance
	Normal: Vector3
	Position: Vector3
end

declare class NumberRange
	Max: number
	Min: number
end

declare NumberRange: {
	new: (InMin: number, InMax: number) -> NumberRange,
}

-- Enums
-- Note: EnumItem and Enum base classes are built into Luau

declare class HttpContentType extends EnumItem
end

declare class HttpContentType_INTERNAL extends Enum
	ApplicationJson: HttpContentType
	ApplicationXml: HttpContentType
	ApplicationUrlEncoded: HttpContentType
	TextPlain: HttpContentType
	TextXml: HttpContentType
end

declare class EasingDirection extends EnumItem
end

declare class EasingDirection_INTERNAL extends Enum
	In: EasingDirection
	Out: EasingDirection
	InOut: EasingDirection
end

declare class HttpCompression extends EnumItem
end

declare class HttpCompression_INTERNAL extends Enum
	None: HttpCompression
	Gzip: HttpCompression
end

declare class ActuatorRelativeTo extends EnumItem
end

declare class ActuatorRelativeTo_INTERNAL extends Enum
	Attachment0: ActuatorRelativeTo
	Attachment1: ActuatorRelativeTo
	World: ActuatorRelativeTo
end

declare class ProximityPromptInputType extends EnumItem
end

declare class ProximityPromptInputType_INTERNAL extends Enum
	Keyboard: ProximityPromptInputType
	Touch: ProximityPromptInputType
end

declare class CollisionChannel extends EnumItem
end

declare class CollisionChannel_INTERNAL extends Enum
	L_ECC_WorldStatic: CollisionChannel
	L_ECC_WorldDynamic: CollisionChannel
	L_ECC_Pawn: CollisionChannel
	L_ECC_Visibility: CollisionChannel
	L_ECC_Camera: CollisionChannel
	L_ECC_PhysicsBody: CollisionChannel
	L_ECC_Vehicle: CollisionChannel
	L_ECC_Destructible: CollisionChannel
	L_ECC_EngineTraceChannel1: CollisionChannel
	L_ECC_EngineTraceChannel2: CollisionChannel
	L_ECC_EngineTraceChannel3: CollisionChannel
	L_ECC_EngineTraceChannel4: CollisionChannel
	L_ECC_WeaponTrace: CollisionChannel
	L_ECC_InteractionTrace: CollisionChannel
	L_ECC_GameTraceChannel1: CollisionChannel
	L_ECC_GameTraceChannel2: CollisionChannel
	L_ECC_GameTraceChannel3: CollisionChannel
	L_ECC_GameTraceChannel4: CollisionChannel
	L_ECC_GameTraceChannel5: CollisionChannel
	L_ECC_GameTraceChannel6: CollisionChannel
	L_ECC_GameTraceChannel7: CollisionChannel
	L_ECC_GameTraceChannel8: CollisionChannel
	L_ECC_GameTraceChannel9: CollisionChannel
	L_ECC_GameTraceChannel10: CollisionChannel
	L_ECC_GameTraceChannel11: CollisionChannel
	L_ECC_GameTraceChannel12: CollisionChannel
	L_ECC_GameTraceChannel13: CollisionChannel
	L_ECC_GameTraceChannel14: CollisionChannel
	L_ECC_GameTraceChannel15: CollisionChannel
	L_ECC_GameTraceChannel16: CollisionChannel
	L_ECC_GameTraceChannel17: CollisionChannel
	L_ECC_GameTraceChannel18: CollisionChannel
	L_ECC_OverlapAll_Deprecated: CollisionChannel
end

declare class PartType extends EnumItem
end

declare class PartType_INTERNAL extends Enum
	Ball: PartType
	Block: PartType
	Cylinder: PartType
end

declare class InfoType extends EnumItem
end

declare class InfoType_INTERNAL extends Enum
	Asset: InfoType
	Product: InfoType
	GamePass: InfoType
	Subscription: InfoType
end

declare class SortOrder extends EnumItem
end

declare class SortOrder_INTERNAL extends Enum
	LayoutOrder: SortOrder
end

declare class ParticleOrientation extends EnumItem
end

declare class ParticleOrientation_INTERNAL extends Enum
	FacingCamera: ParticleOrientation
	FacingCameraWorldUp: ParticleOrientation
	VelocityParallel: ParticleOrientation
	VelocityPerpendicular: ParticleOrientation
end

declare class CollisionResponse extends EnumItem
end

declare class CollisionResponse_INTERNAL extends Enum
	L_ECR_Ignore: CollisionResponse
	L_ECR_Overlap: CollisionResponse
	L_ECR_Block: CollisionResponse
end

declare class PlaybackState extends EnumItem
end

declare class PlaybackState_INTERNAL extends Enum
	Begin: PlaybackState
	Delayed: PlaybackState
	Playing: PlaybackState
	Paused: PlaybackState
	Completed: PlaybackState
	Cancelled: PlaybackState
end

declare class BorderMode extends EnumItem
end

declare class BorderMode_INTERNAL extends Enum
	Insert: BorderMode
	Middle: BorderMode
	Outline: BorderMode
end

declare class ContextActionResult extends EnumItem
end

declare class ContextActionResult_INTERNAL extends Enum
	Sink: ContextActionResult
	Pass: ContextActionResult
end

declare class AssetTypeVerification extends EnumItem
end

declare class AssetTypeVerification_INTERNAL extends Enum
	Default: AssetTypeVerification
	ClientOnly: AssetTypeVerification
	Always: AssetTypeVerification
end

declare class EasingStyle extends EnumItem
end

declare class EasingStyle_INTERNAL extends Enum
	Linear: EasingStyle
	Sine: EasingStyle
	Back: EasingStyle
	Quad: EasingStyle
	Quart: EasingStyle
	Quint: EasingStyle
	Bounce: EasingStyle
	Elastic: EasingStyle
	Exponential: EasingStyle
	Circular: EasingStyle
	Cubic: EasingStyle
end

declare class MaterialCategory extends EnumItem
end

declare class MaterialCategory_INTERNAL extends Enum
	Basic: MaterialCategory
	Wood: MaterialCategory
	Metal: MaterialCategory
	Plastic: MaterialCategory
	Rock: MaterialCategory
	Special: MaterialCategory
	PaintedMetal: MaterialCategory
	PaintedWood: MaterialCategory
	Steel: MaterialCategory
	Floor: MaterialCategory
	Ground: MaterialCategory
	Grass: MaterialCategory
	Paving: MaterialCategory
	Road: MaterialCategory
	Brick: MaterialCategory
	Concrete: MaterialCategory
	Roof: MaterialCategory
	Ceiling: MaterialCategory
	Wall: MaterialCategory
	Tile: MaterialCategory
	Fabric: MaterialCategory
	Carpet: MaterialCategory
	Leather: MaterialCategory
	Rubber: MaterialCategory
	Grid: MaterialCategory
end

declare class ParticleEmitterShape extends EnumItem
end

declare class ParticleEmitterShape_INTERNAL extends Enum
	Box: ParticleEmitterShape
	Sphere: ParticleEmitterShape
	Cylinder: ParticleEmitterShape
	Disc: ParticleEmitterShape
end

declare class MobilityMode extends EnumItem
end

declare class MobilityMode_INTERNAL extends Enum
	Static: MobilityMode
	Movable: MobilityMode
end

declare class ForceLimitMode extends EnumItem
end

declare class ForceLimitMode_INTERNAL extends Enum
	Magnitude: ForceLimitMode
	PerAxis: ForceLimitMode
end

declare class HitboxType extends EnumItem
end

declare class HitboxType_INTERNAL extends Enum
	Single: HitboxType
	SixBody: HitboxType
	FittedSixBody: HitboxType
end

declare class CameraType extends EnumItem
end

declare class CameraType_INTERNAL extends Enum
	Fixed: CameraType
	Attach: CameraType
	Watch: CameraType
	Track: CameraType
	Follow: CameraType
	Custom: CameraType
	Scriptable: CameraType
	Orbital: CameraType
end

declare class RaycastFilterType extends EnumItem
end

declare class RaycastFilterType_INTERNAL extends Enum
	Exclude: RaycastFilterType
	Include: RaycastFilterType
end

declare class NormalId extends EnumItem
end

declare class NormalId_INTERNAL extends Enum
	Right: NormalId
	Top: NormalId
	Back: NormalId
	Left: NormalId
	Bottom: NormalId
	Front: NormalId
end

declare class ProductPurchaseDecision extends EnumItem
end

declare class ProductPurchaseDecision_INTERNAL extends Enum
	NotProcessedYet: ProductPurchaseDecision
	PurchaseGranted: ProductPurchaseDecision
end

declare class ScrollingDirection extends EnumItem
end

declare class ScrollingDirection_INTERNAL extends Enum
	X: ScrollingDirection
	Y: ScrollingDirection
	XY: ScrollingDirection
end

declare class MaterialTextureType extends EnumItem
end

declare class MaterialTextureType_INTERNAL extends Enum
	ColorMap: MaterialTextureType
	MetalnessMap: MaterialTextureType
	NormalMap: MaterialTextureType
	RoughnessMap: MaterialTextureType
	Max: MaterialTextureType
end

declare class TextYAlignment extends EnumItem
end

declare class TextYAlignment_INTERNAL extends Enum
	Top: TextYAlignment
	Center: TextYAlignment
	Bottom: TextYAlignment
end

declare class CreatorType extends EnumItem
end

declare class CreatorType_INTERNAL extends Enum
	User: CreatorType
	Group: CreatorType
end

declare class FillDirection extends EnumItem
end

declare class FillDirection_INTERNAL extends Enum
	Horizontal: FillDirection
	Vertical: FillDirection
end

declare class FillDepthModeType extends EnumItem
end

declare class FillDepthModeType_INTERNAL extends Enum
	AlwaysOnTop: FillDepthModeType
	VisibleWhenNotOccluded: FillDepthModeType
	VisibleWhenOccluded: FillDepthModeType
end

declare class ParticleEmitterShapeStyle extends EnumItem
end

declare class ParticleEmitterShapeStyle_INTERNAL extends Enum
	Volume: ParticleEmitterShapeStyle
	Surface: ParticleEmitterShapeStyle
end

declare class UserInputType extends EnumItem
end

declare class UserInputType_INTERNAL extends Enum
	MouseButton1: UserInputType
	MouseButton2: UserInputType
	MouseButton3: UserInputType
	MouseWheel: UserInputType
	MouseMovement: UserInputType
	Touch: UserInputType
	Keyboard: UserInputType
	Focus: UserInputType
	Accelerometer: UserInputType
	Gyro: UserInputType
	Gamepad1: UserInputType
	Gamepad2: UserInputType
	Gamepad3: UserInputType
	Gamepad4: UserInputType
	Gamepad5: UserInputType
	Gamepad6: UserInputType
	Gamepad7: UserInputType
	Gamepad8: UserInputType
	TextInput: UserInputType
	InputMethod: UserInputType
	None: UserInputType
end

declare class HumanoidDisplayDistanceType extends EnumItem
end

declare class HumanoidDisplayDistanceType_INTERNAL extends Enum
	Viewer: HumanoidDisplayDistanceType
	Subject: HumanoidDisplayDistanceType
	None: HumanoidDisplayDistanceType
end

declare class MaterialPattern extends EnumItem
end

declare class MaterialPattern_INTERNAL extends Enum
	Regular: MaterialPattern
	Organic: MaterialPattern
end

declare class ActionRunnerState extends EnumItem
end

declare class ActionRunnerState_INTERNAL extends Enum
	Playing: ActionRunnerState
	Cancelled: ActionRunnerState
	Completed: ActionRunnerState
end

declare class VerticalAlignment extends EnumItem
end

declare class VerticalAlignment_INTERNAL extends Enum
	Center: VerticalAlignment
	Top: VerticalAlignment
	Bottom: VerticalAlignment
end

declare class UserInputState extends EnumItem
end

declare class UserInputState_INTERNAL extends Enum
	Begin: UserInputState
	Change: UserInputState
	End: UserInputState
	Cancel: UserInputState
	None: UserInputState
end

declare class AspectType extends EnumItem
end

declare class AspectType_INTERNAL extends Enum
	FitWithinMaxSize: AspectType
	ScaleWithParentSize: AspectType
end

declare class RollOffMode extends EnumItem
end

declare class RollOffMode_INTERNAL extends Enum
	Inverse: RollOffMode
	Linear: RollOffMode
	LinearSquare: RollOffMode
	InverseTapered: RollOffMode
end

declare class ParticleEmitterShapeInOut extends EnumItem
end

declare class ParticleEmitterShapeInOut_INTERNAL extends Enum
	Outward: ParticleEmitterShapeInOut
	Inward: ParticleEmitterShapeInOut
end

declare class RotationType extends EnumItem
end

declare class RotationType_INTERNAL extends Enum
	MovementRelative: RotationType
	CameraRelative: RotationType
	None: RotationType
end

declare class ProximityPromptExclusivity extends EnumItem
end

declare class ProximityPromptExclusivity_INTERNAL extends Enum
	OnePerButton: ProximityPromptExclusivity
	OneGlobally: ProximityPromptExclusivity
	AlwaysShow: ProximityPromptExclusivity
end

declare class HumanoidStateType extends EnumItem
end

declare class HumanoidStateType_INTERNAL extends Enum
	FallingDown: HumanoidStateType
	Ragdoll: HumanoidStateType
	GettingUp: HumanoidStateType
	Jumping: HumanoidStateType
	Swimming: HumanoidStateType
	Freefall: HumanoidStateType
	Flying: HumanoidStateType
	Landed: HumanoidStateType
	Running: HumanoidStateType
	RunningNoPhysics: HumanoidStateType
	StrafingNoPhysics: HumanoidStateType
	Climbing: HumanoidStateType
	Seated: HumanoidStateType
	PlatformStanding: HumanoidStateType
	Dead: HumanoidStateType
	Physics: HumanoidStateType
	None: HumanoidStateType
end

declare class VFXPerformanceType extends EnumItem
end

declare class VFXPerformanceType_INTERNAL extends Enum
	Default: VFXPerformanceType
	Environment_Burst: VFXPerformanceType
	Gameplay_Burst_Critical: VFXPerformanceType
	Environment_Looping: VFXPerformanceType
	Gameplay_Burst: VFXPerformanceType
	Gameplay_Looping: VFXPerformanceType
	Default_Burst: VFXPerformanceType
	Default_Loop: VFXPerformanceType
end

declare class AutomaticSize extends EnumItem
end

declare class AutomaticSize_INTERNAL extends Enum
	None: AutomaticSize
	X: AutomaticSize
	Y: AutomaticSize
	XY: AutomaticSize
end

declare class CameraMode extends EnumItem
end

declare class CameraMode_INTERNAL extends Enum
	Classic: CameraMode
	LockFirstPerson: CameraMode
end

declare class Material extends EnumItem
end

declare class Material_INTERNAL extends Enum
	Basic: Material
	Plastic: Material
	Brick: Material
	Rock: Material
	Metal: Material
	Unlit: Material
	Bark: Material
	SmallBrick: Material
	LeafyGround: Material
	MossyGround: Material
	Ground: Material
	Glass: Material
	Paving: Material
	MossyRock: Material
	Plank: Material
	Wood: Material
	Neon: Material
	Asphalt: Material
	Concrete: Material
	Marble: Material
	MetalPlate: Material
	Rust: Material
	Snow: Material
	StoneBrick: Material
	StoneFloor: Material
	SilverMetal: Material
	CorrugatedSteel: Material
	Sand: Material
	Grass: Material
	PavingStones: Material
	Road: Material
	WhiteGrayBrick: Material
	ConcretePlate: Material
	Roof: Material
	GridQuad: Material
	DistroyedBronze: Material
	HalfLeafyGround: Material
	PavingWall: Material
	GridBox: Material
	RustBrass: Material
	PavingFloor: Material
	GridTile: Material
	PavingBrick: Material
	GridPentagon: Material
	GridMarble: Material
	Copper: Material
	TerrazzoFloor: Material
	CheckerTileFloor: Material
	SoilRockGround: Material
	PavingBlock: Material
	MixRoad: Material
	HouseBricks: Material
	BrokenConcrete: Material
	DamagedRoof: Material
	OfficeCeilingWhite: Material
	CementWall: Material
	CrackedSmallCeramicTile: Material
	CrackedMiddleCeramicTile: Material
	TakenOffCeramicTile: Material
	MosaicCarpet: Material
	BrushMetal: Material
	PaintedMetal: Material
	PaintedWood: Material
	IndustrialRibbedSteel: Material
	PeelingPaintSteel: Material
	RustySteel: Material
	UrbanSlateFloor: Material
	BeigeTerrazzoFloor: Material
	GreyWovenFabric: Material
	ThickCarpet: Material
	EmeraldGridTile: Material
	OceanPanelTile: Material
	BrickCeramicTile: Material
	SquareCeramicTile: Material
	GridBorder: Material
	GalvanizedMetal: Material
	WeatheredPlasterBrick: Material
	WhiteCementBrick: Material
	SandstoneBrick: Material
	BrokenRoof: Material
	Foil: Material
	RustMetal: Material
	PaintedWornWood: Material
	Chainmail: Material
	WoodTileFloor: Material
	Tatami: Material
	OfficeCeilingLight: Material
	WoodSidingWall: Material
	WoodLogSidingWall: Material
	FabricDenim: Material
	FabricWeave: Material
	GrainLeather: Material
	CrocEmbossedLeather: Material
	MatteRubber: Material
	Max: Material
	LastMaterial: Material
end

declare class GuiButtonState extends EnumItem
end

declare class GuiButtonState_INTERNAL extends Enum
	Default: GuiButtonState
	Hover: GuiButtonState
	Press: GuiButtonState
	Max: GuiButtonState
end

declare class VelocityConstraintMode extends EnumItem
end

declare class VelocityConstraintMode_INTERNAL extends Enum
	Line: VelocityConstraintMode
	Plane: VelocityConstraintMode
	Vector: VelocityConstraintMode
end

declare class VFXImportance extends EnumItem
end

declare class VFXImportance_INTERNAL extends Enum
	Default: VFXImportance
	Background: VFXImportance
	Gameplay: VFXImportance
	Critical: VFXImportance
end

declare class KeyCode extends EnumItem
end

declare class KeyCode_INTERNAL extends Enum
	Unknown: KeyCode
	Joystick: KeyCode
	Backspace: KeyCode
	Tab: KeyCode
	Clear: KeyCode
	Return: KeyCode
	Pause: KeyCode
	Escape: KeyCode
	Space: KeyCode
	QuotedDouble: KeyCode
	Hash: KeyCode
	Dollar: KeyCode
	Percent: KeyCode
	Ampersand: KeyCode
	Quote: KeyCode
	LeftParenthesis: KeyCode
	RightParenthesis: KeyCode
	Asterisk: KeyCode
	Plus: KeyCode
	Comma: KeyCode
	Minus: KeyCode
	Period: KeyCode
	Slash: KeyCode
	Zero: KeyCode
	One: KeyCode
	Two: KeyCode
	Three: KeyCode
	Four: KeyCode
	Five: KeyCode
	Six: KeyCode
	Seven: KeyCode
	Eight: KeyCode
	Nine: KeyCode
	Colon: KeyCode
	Semicolon: KeyCode
	LessThan: KeyCode
	Equals: KeyCode
	GreaterThan: KeyCode
	Question: KeyCode
	At: KeyCode
	LeftBracket: KeyCode
	BackSlash: KeyCode
	RightBracket: KeyCode
	Caret: KeyCode
	Underscore: KeyCode
	Backquote: KeyCode
	A: KeyCode
	B: KeyCode
	C: KeyCode
	D: KeyCode
	E: KeyCode
	F: KeyCode
	G: KeyCode
	H: KeyCode
	I: KeyCode
	J: KeyCode
	K: KeyCode
	L: KeyCode
	M: KeyCode
	N: KeyCode
	O: KeyCode
	P: KeyCode
	Q: KeyCode
	R: KeyCode
	S: KeyCode
	T: KeyCode
	U: KeyCode
	V: KeyCode
	W: KeyCode
	X: KeyCode
	Y: KeyCode
	Z: KeyCode
	LeftCurly: KeyCode
	Pipe: KeyCode
	RightCurly: KeyCode
	Tilde: KeyCode
	Delete: KeyCode
	KeypadZero: KeyCode
	KeypadOne: KeyCode
	KeypadTwo: KeyCode
	KeypadThree: KeyCode
	KeypadFour: KeyCode
	KeypadFive: KeyCode
	KeypadSix: KeyCode
	KeypadSeven: KeyCode
	KeypadEight: KeyCode
	KeypadNine: KeyCode
	KeypadPeriod: KeyCode
	KeypadDivide: KeyCode
	KeypadMultiply: KeyCode
	KeypadMinus: KeyCode
	KeypadPlus: KeyCode
	KeypadEnter: KeyCode
	KeypadEquals: KeyCode
	Up: KeyCode
	Down: KeyCode
	Right: KeyCode
	Left: KeyCode
	Insert: KeyCode
	Home: KeyCode
	End: KeyCode
	PageUp: KeyCode
	PageDown: KeyCode
	F1: KeyCode
	F2: KeyCode
	F3: KeyCode
	F4: KeyCode
	F5: KeyCode
	F6: KeyCode
	F7: KeyCode
	F8: KeyCode
	F9: KeyCode
	F10: KeyCode
	F11: KeyCode
	F12: KeyCode
	F13: KeyCode
	F14: KeyCode
	F15: KeyCode
	NumLock: KeyCode
	CapsLock: KeyCode
	ScrollLock: KeyCode
	RightShift: KeyCode
	LeftShift: KeyCode
	RightControl: KeyCode
	LeftControl: KeyCode
	RightAlt: KeyCode
	LeftAlt: KeyCode
	RightMeta: KeyCode
	LeftMeta: KeyCode
	LeftSuper: KeyCode
	RightSuper: KeyCode
	Mode: KeyCode
	Compose: KeyCode
	Help: KeyCode
	Print: KeyCode
	SysReq: KeyCode
	Break: KeyCode
	Menu: KeyCode
	Power: KeyCode
	Euro: KeyCode
	Undo: KeyCode
	ButtonX: KeyCode
	ButtonY: KeyCode
	ButtonA: KeyCode
	ButtonB: KeyCode
	ButtonR1: KeyCode
	ButtonL1: KeyCode
	ButtonR2: KeyCode
	ButtonL2: KeyCode
	ButtonR3: KeyCode
	ButtonL3: KeyCode
	ButtonStart: KeyCode
	ButtonSelect: KeyCode
	DPadLeft: KeyCode
	DPadRight: KeyCode
	DPadUp: KeyCode
	DPadDown: KeyCode
	Thumbstick1: KeyCode
	Thumbstick2: KeyCode
end

declare class DominantAxis extends EnumItem
end

declare class DominantAxis_INTERNAL extends Enum
	Width: DominantAxis
	Height: DominantAxis
end

declare class ParticleFlipbookLayout extends EnumItem
end

declare class ParticleFlipbookLayout_INTERNAL extends Enum
	None: ParticleFlipbookLayout
	Grid2x2: ParticleFlipbookLayout
	Grid4x4: ParticleFlipbookLayout
	Grid8x8: ParticleFlipbookLayout
end

declare class SoundPlayState extends EnumItem
end

declare class SoundPlayState_INTERNAL extends Enum
	Played: SoundPlayState
	Resumed: SoundPlayState
	Paused: SoundPlayState
	Stopped: SoundPlayState
	ResumedByProperty: SoundPlayState
	PausedByProperty: SoundPlayState
	Ended: SoundPlayState
end

declare class CoreGuiType extends EnumItem
end

declare class CoreGuiType_INTERNAL extends Enum
	PlayerList: CoreGuiType
	Health: CoreGuiType
	Backpack: CoreGuiType
	Chat: CoreGuiType
	All: CoreGuiType
	EmotesMenu: CoreGuiType
	SelfView: CoreGuiType
	Joystick: CoreGuiType
	JumpButton: CoreGuiType
end

declare class TextXAlignment extends EnumItem
end

declare class TextXAlignment_INTERNAL extends Enum
	Left: TextXAlignment
	Right: TextXAlignment
	Center: TextXAlignment
end

declare class BallState extends EnumItem
end

declare class BallState_INTERNAL extends Enum
	Stopped: BallState
	Paused: BallState
	Playing: BallState
end

declare class AnimationPriority extends EnumItem
end

declare class AnimationPriority_INTERNAL extends Enum
	Action4: AnimationPriority
	Action3: AnimationPriority
	Action2: AnimationPriority
	Action: AnimationPriority
	Movement: AnimationPriority
	Idle: AnimationPriority
	Core: AnimationPriority
	None: AnimationPriority
end

declare class ZIndexMode extends EnumItem
end

declare class ZIndexMode_INTERNAL extends Enum
	Sibling: ZIndexMode
	Global: ZIndexMode
end

declare class ParticleFlipbookMode extends EnumItem
end

declare class ParticleFlipbookMode_INTERNAL extends Enum
	Loop: ParticleFlipbookMode
	OneShot: ParticleFlipbookMode
	PingPong: ParticleFlipbookMode
	Random: ParticleFlipbookMode
end

declare class HorizontalAlignment extends EnumItem
end

declare class HorizontalAlignment_INTERNAL extends Enum
	Center: HorizontalAlignment
	Left: HorizontalAlignment
	Right: HorizontalAlignment
end

declare class ShadowDetailLevel extends EnumItem
end

declare class ShadowDetailLevel_INTERNAL extends Enum
	Original: ShadowDetailLevel
	Medium: ShadowDetailLevel
	Low: ShadowDetailLevel
end

declare class EnumContainer
	HttpContentType: HttpContentType_INTERNAL
	EasingDirection: EasingDirection_INTERNAL
	HttpCompression: HttpCompression_INTERNAL
	ActuatorRelativeTo: ActuatorRelativeTo_INTERNAL
	ProximityPromptInputType: ProximityPromptInputType_INTERNAL
	CollisionChannel: CollisionChannel_INTERNAL
	PartType: PartType_INTERNAL
	InfoType: InfoType_INTERNAL
	SortOrder: SortOrder_INTERNAL
	ParticleOrientation: ParticleOrientation_INTERNAL
	CollisionResponse: CollisionResponse_INTERNAL
	PlaybackState: PlaybackState_INTERNAL
	BorderMode: BorderMode_INTERNAL
	ContextActionResult: ContextActionResult_INTERNAL
	AssetTypeVerification: AssetTypeVerification_INTERNAL
	EasingStyle: EasingStyle_INTERNAL
	MaterialCategory: MaterialCategory_INTERNAL
	ParticleEmitterShape: ParticleEmitterShape_INTERNAL
	MobilityMode: MobilityMode_INTERNAL
	ForceLimitMode: ForceLimitMode_INTERNAL
	HitboxType: HitboxType_INTERNAL
	CameraType: CameraType_INTERNAL
	RaycastFilterType: RaycastFilterType_INTERNAL
	NormalId: NormalId_INTERNAL
	ProductPurchaseDecision: ProductPurchaseDecision_INTERNAL
	ScrollingDirection: ScrollingDirection_INTERNAL
	MaterialTextureType: MaterialTextureType_INTERNAL
	TextYAlignment: TextYAlignment_INTERNAL
	CreatorType: CreatorType_INTERNAL
	FillDirection: FillDirection_INTERNAL
	FillDepthModeType: FillDepthModeType_INTERNAL
	ParticleEmitterShapeStyle: ParticleEmitterShapeStyle_INTERNAL
	UserInputType: UserInputType_INTERNAL
	HumanoidDisplayDistanceType: HumanoidDisplayDistanceType_INTERNAL
	MaterialPattern: MaterialPattern_INTERNAL
	ActionRunnerState: ActionRunnerState_INTERNAL
	VerticalAlignment: VerticalAlignment_INTERNAL
	UserInputState: UserInputState_INTERNAL
	AspectType: AspectType_INTERNAL
	RollOffMode: RollOffMode_INTERNAL
	ParticleEmitterShapeInOut: ParticleEmitterShapeInOut_INTERNAL
	RotationType: RotationType_INTERNAL
	ProximityPromptExclusivity: ProximityPromptExclusivity_INTERNAL
	HumanoidStateType: HumanoidStateType_INTERNAL
	VFXPerformanceType: VFXPerformanceType_INTERNAL
	AutomaticSize: AutomaticSize_INTERNAL
	CameraMode: CameraMode_INTERNAL
	Material: Material_INTERNAL
	GuiButtonState: GuiButtonState_INTERNAL
	VelocityConstraintMode: VelocityConstraintMode_INTERNAL
	VFXImportance: VFXImportance_INTERNAL
	KeyCode: KeyCode_INTERNAL
	DominantAxis: DominantAxis_INTERNAL
	ParticleFlipbookLayout: ParticleFlipbookLayout_INTERNAL
	SoundPlayState: SoundPlayState_INTERNAL
	CoreGuiType: CoreGuiType_INTERNAL
	TextXAlignment: TextXAlignment_INTERNAL
	BallState: BallState_INTERNAL
	AnimationPriority: AnimationPriority_INTERNAL
	ZIndexMode: ZIndexMode_INTERNAL
	ParticleFlipbookMode: ParticleFlipbookMode_INTERNAL
	HorizontalAlignment: HorizontalAlignment_INTERNAL
	ShadowDetailLevel: ShadowDetailLevel_INTERNAL
end

declare Enum: EnumContainer

-- Classes
declare class Instance
	Archivable: boolean
	ClassName: string
	DisableAdaptiveNetUpdateFrequency: boolean
	Mobility: MobilityMode
	Name: string
	Parent: Instance
	function AddTag(self, tag: string): ()
	function Clone(self): Instance
	function Destroy(self): ()
	function FindFirstAncestor(self, InName: string): Instance
	function FindFirstAncestorOfClass(self, InClassName: string): Instance
	function FindFirstAncestorWhichIsA(self, InClassName: string): Instance
	function FindFirstChild(self, InName: string, recursive: boolean): Instance
	function FindFirstChildOfClass(self, InClassName: string, Recursive: boolean): Instance
	function GetAttribute(self, attribute: string): any
	function GetAttributeChangedSignal(self, InAttributeName: string): ScriptSignal
	function GetAttributes(self): {[string]: any}
	function GetChildren(self): {any}
	function GetChildrenNum(self): number
	function GetDescendants(self): {any}
	function GetFullName(self): string
	function GetPropertyChangedSignal(self, InPropertyName: string): ScriptSignal
	function GetTags(self): {any}
	function HasTag(self, tag: string): boolean
	function IsA(self, InClassName: string): boolean
	function IsDescendantOf(self, InAncestor: Instance): boolean
	function RemoveTag(self, tag: string): ()
	function SetAttribute(self, attribute: string, value: any): ()
	function WaitForChild(self, InChildName: string, InTimeOut: number?): Instance
	AncestryChanged: ScriptSignal
	AttributeChanged: ScriptSignal
	Changed: ScriptSignal
	ChildAdded: ScriptSignal
	ChildRemoved: ScriptSignal
	DescendantAdded: ScriptSignal
	DescendantRemoving: ScriptSignal
	Destroying: ScriptSignal
end

declare class Backpack extends Instance
end

declare class ServerScriptService extends Instance
end

declare class SoundService extends Instance
	RolloffScale: number
end

declare class GuiBase2d extends Instance
	AbsolutePosition: Vector2
	AbsoluteSize: Vector2
	AutoLocalize: boolean
end

declare class GuiObject extends GuiBase2d
	Active: boolean
	AnchorPoint: Vector2
	BackgroundColor3: Color3
	BackgroundTransparency: number
	ClipsDescendants: boolean
	LayoutOrder: number
	Position: UDim2
	Rotation: number
	Size: UDim2
	Visible: boolean
	ZIndex: number
	InputBegan: ScriptSignal
	InputChanged: ScriptSignal
	InputEnded: ScriptSignal
end

declare class Frame extends GuiObject
	BorderColor3: Color3
	BorderMode: BorderMode
	BorderPixelSize: number
end

declare class Animator extends Instance
	function LoadAnimation(self, InAnimation: Animation): AnimationTrack
end

declare class Constraint extends Instance
	Attachment0: Attachment
	Attachment1: Attachment
	Enabled: boolean
end

declare class LinearVelocity extends Constraint
	ForceLimitsEnabled: boolean
	LineDirection: Vector3
	LineVelocity: number
	MaxForce: number
	PlaneVelocity: Vector2
	PrimaryTangentAxis: Vector3
	RelativeTo: ActuatorRelativeTo
	SecondaryTangentAxis: Vector3
	VectorVelocity: Vector3
	VelocityConstraintMode: VelocityConstraintMode
end

declare class ImageLabel extends GuiObject
	Image: string
	ImageColor3: Color3
	ImageTransparency: number
end

declare class MaterialVariant extends Instance
	BaseMaterial: Material
	ColorMap: Content
	CustomPhysicalProperties: PhysicalProperties
	Emissive: Color3
	EmissiveIntensity: number
	EmissiveMap: Content
	Metalness: number
	MetalnessMap: Content
	MetersPerTile: number
	NormalMap: Content
	Roughness: number
	RoughnessMap: Content
	UseCustomPhysicsProperties: boolean
end

declare class Light extends Instance
	Brightness: number
	Color: Color3
	Enabled: boolean
end

declare class PointLight extends Light
	Range: number
end

declare class AnimationTrack extends Instance
	Animation: Animation
	BlendByInertialization: boolean
	IsPlaying: boolean
	Length: number
	Looped: boolean
	Priority: AnimationPriority
	Speed: number
	TimePosition: number
	UpperBodyAnimation: boolean
	function AdjustSpeed(self, InSpeed: number): ()
	function AdjustWeight(self, InWeight: number, InFadeTime: number): ()
	function GetMarkerReachedSignal(self, InName: string): ScriptSignal
	function Play(self, InFadeTime: number, InWeight: number, InSpeed: number): ()
	function Stop(self, InFadeTime: number): ()
	DidLoop: ScriptSignal
	Ended: ScriptSignal
	KeyframeReached: ScriptSignal
	Stopped: ScriptSignal
end

declare class Players extends Instance
	CharacterAutoLoads: boolean
	LocalPlayer: Player
	RespawnTime: number
	UseStrafingAnimations: boolean
	function GetPlayerByUserId(self, UserId: string): Player
	function GetPlayerFromCharacter(self, InCharacter: Model): Player
	function GetPlayers(self): {any}
	PlayerAdded: ScriptSignal
	PlayerRemoving: ScriptSignal
end

declare class GuiButton extends GuiObject
	Activated: ScriptSignal
end

declare class LayerCollector extends GuiBase2d
	Enabled: boolean
end

declare class SurfaceGuiBase extends LayerCollector
	Active: boolean
	Adornee: Instance
	AlwaysOnTop: boolean
	Brightness: number
	ClipsDescendants: boolean
	LightInfluence: number
	MaxDistance: number
	Size: UDim2
	ZIndexBehavior: ZIndexMode
end

declare class OverlayBase extends Instance
	Adornee: Instance
	Enabled: boolean
end

declare class PVInstance extends Instance
	Origin: CFrame
	PivotOffsetCFrame: CFrame
	function GetPivot(self): CFrame
	function PivotTo(self, InTargetCFrame: CFrame): ()
end

declare class BasePart extends PVInstance
	Anchored: boolean
	AssemblyLinearVelocity: Vector3
	AssemblyRootPart: BasePart
	BrickColor: BrickColor
	CanClimb: boolean
	CanCollide: boolean
	CanQuery: boolean
	CanTouch: boolean
	CastShadow: boolean
	CFrame: CFrame
	CollisionObjectType: string
	CollisionProfile: string
	Color: Color3
	CurrentPhysicalProperties: PhysicalProperties
	CustomPhysicalProperties: PhysicalProperties
	IsTouchingBodyPart: boolean
	Locked: boolean
	Material: Material
	MaterialVariant: string
	Orientation: Vector3
	Position: Vector3
	Size: Vector3
	Transparency: number
	function ApplyImpulse(self, InImpulse: Vector3): ()
	function GetCollisionProfile(self): string
	function GetMass(self): number
	function SetCollisionProfile(self, InProfileName: string): ()
	Touched: ScriptSignal
	TouchEnded: ScriptSignal
end

declare class Mouse extends Instance
	Hit: CFrame
	Origin: CFrame
	Target: BasePart
	ViewSizeX: number
	ViewSizeY: number
	X: number
	Y: number
	Button1Down: ScriptSignal
	Button1Up: ScriptSignal
	Button2Down: ScriptSignal
	Button2Up: ScriptSignal
	TouchEnded: ScriptSignal
	TouchStarted: ScriptSignal
end

declare class ProximityPrompt extends Instance
	ActionText: string
	AutoLocalize: boolean
	ClickablePrompt: boolean
	Enabled: boolean
	Exclusivity: ProximityPromptExclusivity
	HoldDuration: number
	KeyboardKeyCode: KeyCode
	MaxActivationDistance: number
	ObjectText: string
	RequiresLineOfSight: boolean
	UIOffset: Vector2
	function InputHoldBegin(self): ()
	function InputHoldEnd(self): ()
	PromptButtonHoldBegan: ScriptSignal
	PromptButtonHoldEnded: ScriptSignal
	PromptHidden: ScriptSignal
	PromptShown: ScriptSignal
	Triggered: ScriptSignal
	TriggerEnded: ScriptSignal
end

declare class Pages extends Instance
	IsFinished: boolean
	function AdvanceToNextPageAsync(self): ()
	function GetCurrentPage(self): any
end

declare class DataStoreListingPages extends Pages
	Cursor: string
end

declare class ProximityPromptService extends Instance
	Enabled: boolean
	MaxPromptsVisible: number
	PromptButtonHoldBegan: ScriptSignal
	PromptButtonHoldEnded: ScriptSignal
	PromptHidden: ScriptSignal
	PromptShown: ScriptSignal
	PromptTriggered: ScriptSignal
	PromptTriggerEnded: ScriptSignal
end

declare class TweenBase extends Instance
	PlaybackState: PlaybackState
	Completed: ScriptSignal
end

declare class Tween extends TweenBase
	Instance: Instance
	TweenInfo: TweenInfo
	function Cancel(self): ()
	function Pause(self): ()
	function Play(self): ()
end

declare class StarterPack extends Instance
end

declare class WrapLayer extends Instance
	Order: number
end

declare class UserInputService extends Instance
	InputBegan: ScriptSignal
	InputChanged: ScriptSignal
	InputEnded: ScriptSignal
	TouchEnded: ScriptSignal
	TouchMoved: ScriptSignal
	TouchStarted: ScriptSignal
end

declare class Model extends PVInstance
	CastShadow: boolean
	PrimaryPart: BasePart
	WorldPivot: CFrame
	function GetPivot(self): CFrame
	function MoveTo(self, InPosition: Vector3): ()
	function PivotTo(self, InTargetCFrame: CFrame): ()
	function SetPrimaryPartCFrame(self, InNewCFrame: CFrame): ()
end

declare class HttpService extends Instance
	HttpEnabled: boolean
	function GenerateGUID(self, InWrapInCurlyBraces: boolean): string
	function GetAsync(self, InUrl: string, InNoCache: boolean, InHeaders: any): string
	function JSONDecode(self, InInput: string): any
	function JSONEncode(self, InInput: any): string
	function PostAsync(self, InUrl: string, InData: string, InContentType: HttpContentType, InCompress: boolean, InHeaders: any): string
	function RequestAsync(self, InRequestOptions: {[string]: any}): any
	function UrlEncode(self, InInput: string): string
end

declare class Animation extends Instance
	AnimationId: string
end

declare class Player extends Instance
	CameraMaxZoomDistance: number
	CameraMinZoomDistance: number
	Character: Model
	LocaleId: string
	RespawnLocation: SpawnLocation
	TeamColor: BrickColor
	UserId: string
	function GetMouse(self): Mouse
	function GetNetworkPing(self): number
	function LoadCharacter(self): ()
	function RemoveCharacter(self): ()
	CharacterAdded: ScriptSignal
	CharacterRemoving: ScriptSignal
end

declare class SurfaceGui extends SurfaceGuiBase
	Face: NormalId
	ZOffset: number
end

declare class ServiceProvider extends Instance
	function FindService(self, InClassName: string): Instance
	function GetService(self, InClassName: string): Instance
end

declare class DataStoreSetOptions extends Instance
	function GetMetadata(self): {[string]: any}
	function SetMetadata(self, InMetaDataTable: {[string]: any}): ()
end

declare class LuaSourceContainer extends Instance
end

declare class ModuleScript extends LuaSourceContainer
end

declare class Outline extends OverlayBase
	Color: Color3
	Thickness: number
end

declare class StarterGui extends Instance
	function GetCoreGuiEnabled(self, CoreGuiType: CoreGuiType): boolean
	function SetCoreGuiEnabled(self, CoreGuiType: CoreGuiType, Enabled: boolean): ()
end

declare class Camera extends Instance
	CameraOffset: Vector3
	CameraSubject: Instance
	CameraType: CameraType
	CFrame: CFrame
	EnableSmoothFollow: boolean
	EnableSmoothRotation: boolean
	FieldOfView: number
	FollowMaxDistance: number
	RotationInput: Vector3
	SmoothFollowSpeed: number
	SmoothRotationSpeed: number
	ViewportSize: Vector2
	function GetLargestCutoffDistance(self, InIgnoreList: {any}): any
	function ScreenPointToRay(self, x: number, y: number, depth: number): Ray
	function ViewportPointToRay(self, x: number, y: number, depth: number): Ray
	function WorldToViewportPoint(self, WorldPoint: Vector3): any
end

declare class Attachment extends Instance
	Axis: Vector3
	CFrame: CFrame
	SecondaryAxis: Vector3
	WorldAxis: Vector3
	WorldCFrame: CFrame
	WorldSecondaryAxis: Vector3
	function GetConstraints(self): {any}
end

declare class UIGridStyleLayout extends Instance
	AbsoluteContentSize: Vector2
	FillDirection: FillDirection
	HorizontalAlignment: HorizontalAlignment
	SortOrder: SortOrder
	VerticalAlignment: VerticalAlignment
end

declare class UIGridLayout extends UIGridStyleLayout
	CellPadding: UDim2
	CellSize: UDim2
	FillDirectionMaxCells: number
end

declare class GlobalDataStore extends Instance
	function GetAsync(self, InKey: string, InOptions: DataStoreGetOptions?): any
	function IncrementAsync(self, InKey: string, InDelta: number, InUserIds: {any}?, InOptions: DataStoreIncrementOptions?): any
	function RemoveAsync(self, InKey: string): any
	function SetAsync(self, InKey: string, InValue: any, InUserIds: any?, InOptions: DataStoreSetOptions?): any
	function UpdateAsync(self, InKey: string, InTransformFunction: any): any
end

declare class DataStore extends GlobalDataStore
	function ListKeysAsync(self, InPrefix: string, InPageSize: number, InCursor: string, InExcludeDeleted: boolean): DataStoreKeyPages
end

declare class DataStoreInfo extends Instance
	CreatedTime: number
	DataStoreName: string
	UpdatedTime: number
end

declare class BackpackItem extends Instance
	TextureId: string
end

declare class Tool extends BackpackItem
	CanBeDropped: boolean
	Enabled: boolean
	Grip: CFrame
	function Activate(self): ()
	function Deactivate(self): ()
	Activated: ScriptSignal
	Deactivated: ScriptSignal
	Equipped: ScriptSignal
	Unequipped: ScriptSignal
end

declare class Bone extends Attachment
	Transform: CFrame
	TransformedCFrame: CFrame
	TransformedWorldCFrame: CFrame
end

declare class StarterPlayerScripts extends Instance
end

declare class Atmosphere extends Instance
	AirColor: Color3
	CloudAmount: number
	CloudSpeed: number
	CloudTexture: string
	Color: Color3
	Density: number
	FogColor: Color3
	FogDensity: number
	FogFalloff: number
	FogFalloffClear: number
	FogHorizon: boolean
	FogStart: number
	GlareColor: Color3
	GlareFalloff: number
	HazeColor: Color3
	HazeSpread: number
	StartDistance: number
end

declare class StarterPlayer extends Instance
	AirControl: number
	CameraMaxZoomDistance: number
	CameraMinZoomDistance: number
	CapsuleHeight: number
	CapsuleRadius: number
	CharacterMeshPos: Vector3
	FallingDeceleration: number
	FallingLateralFriction: number
	GravityScale: number
	GroundFriction: number
	IgnoreBaseRotation: boolean
	JumpHeight: number
	JumpPower: number
	LoadCharacterAppearance: boolean
	MaxAcceleration: number
	MaxJumpCount: number
	MaxSlopeAngle: number
	RotationSpeed: number
	StompJumpMultiplier: number
	UseJumpPower: boolean
	WalkingDeceleration: number
	WalkSpeed: number
end

declare class OrderedDataStore extends GlobalDataStore
end

declare class WorldRoot extends Instance
	function Blockcast(self, InCFrame: CFrame, InExtents: Vector3, InDirection: Vector3, InRaycastParams: RaycastParams?): RaycastResult
	function BlockcastSingleByChannel(self, InCFrame: CFrame, InExtents: Vector3, InDirection: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): RaycastResult
	function BlockcastSingleByObject(self, InCFrame: CFrame, InExtents: Vector3, InDirection: Vector3, InQueryParams: any, InObjectParams: any): RaycastResult
	function BlockcastSingleByProfile(self, InCFrame: CFrame, InExtents: Vector3, InDirection: Vector3, ProfileName: string, InQueryParams: any): RaycastResult
	function Capsulecast(self, InCFrame: CFrame, InRadius: number, InHeight: number, InDirection: Vector3, InRaycastParams: RaycastParams?): RaycastResult
	function CapsulecastSingleByChannel(self, InCFrame: CFrame, InRadius: number, InHeight: number, InDirection: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): RaycastResult
	function CapsulecastSingleByObject(self, InCFrame: CFrame, InRadius: number, InHeight: number, InDirection: Vector3, InQueryParams: any, InObjectParams: any): RaycastResult
	function CapsulecastSingleByProfile(self, InCFrame: CFrame, InRadius: number, InHeight: number, InDirection: Vector3, ProfileName: string, InQueryParams: any): RaycastResult
	function DrawRay(self, InOrigin: Vector3, InDirection: Vector3, InColor: Color3, InThickness: number, InLifeTime: number): ()
	function GetPartBoundsInBox(self, InCenter: CFrame, InSize: Vector3, InOverlapParams: OverlapParams?): {any}
	function GetPartBoundsInBoxByChannel(self, InCenter: CFrame, InSize: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): {any}
	function GetPartBoundsInSphere(self, InCenter: CFrame, InRadius: number, InOverlapParams: OverlapParams?): {any}
	function GetPartBoundsInSphereByChannel(self, InCenter: CFrame, InRadius: number, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): {any}
	function GetPartsInPart(self, InBasePart: BasePart, InOverlapParams: OverlapParams?): {any}
	function PredictProjectilePathByChannel(self, InTraceChannel: CollisionChannel, PredictParams: any, InResponseParams: any?): any
	function PredictProjectilePathByObject(self, PredictParams: any, InObjectParams: any): any
	function Raycast(self, InOrigin: Vector3, InDirection: Vector3, InRaycastParams: RaycastParams?): RaycastResult
	function RaycastMulti(self, InOrigin: Vector3, InDirection: Vector3, InRaycastParams: RaycastParams?): {any}
	function RaycastMultiByChannel(self, InOrigin: Vector3, InDirection: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): {any}
	function RaycastMultiByObject(self, InOrigin: Vector3, InDirection: Vector3, InQueryParams: any, InObjectParams: any): {any}
	function RaycastMultiByProfile(self, InOrigin: Vector3, InDirection: Vector3, ProfileName: string, InQueryParams: any): {any}
	function RaycastSingleByChannel(self, InOrigin: Vector3, InDirection: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): RaycastResult
	function RaycastSingleByObject(self, InOrigin: Vector3, InDirection: Vector3, InQueryParams: any, InObjectParams: any): RaycastResult
	function RaycastSingleByProfile(self, InOrigin: Vector3, InDirection: Vector3, ProfileName: string, InQueryParams: any): RaycastResult
	function Spherecast(self, InOrigin: Vector3, InRadius: number, InDirection: Vector3, InRaycastParams: RaycastParams?): RaycastResult
	function SpherecastSingleByChannel(self, InCFrame: CFrame, InRadius: number, InDirection: Vector3, TraceChannel: CollisionChannel, InQueryParams: any?, InResponseParams: any?): RaycastResult
	function SpherecastSingleByObject(self, InCFrame: CFrame, InRadius: number, InDirection: Vector3, InQueryParams: any, InObjectParams: any): RaycastResult
	function SpherecastSingleByProfile(self, InCFrame: CFrame, InRadius: number, InDirection: Vector3, ProfileName: string, InQueryParams: any): RaycastResult
end

declare class Workspace extends WorldRoot
	CurrentCamera: Camera
	Gravity: number
	HitboxType: HitboxType
	function GetServerTimeNow(self): number
end

declare class SimulationBall extends PVInstance
	BallMeshCollisionProfile: string
	BallRadius: number
	BallState: BallState
	BallTraceChannel: number
	CFrame: CFrame
	Color: Color3
	EnablePathMarker: boolean
	IsPathMarkerWorldSpace: boolean
	Material: Material
	MaterialVariant: string
	PathMarkerScale: number
	Position: Vector3
	SlomoFactor: number
	TextureId: string
	Transparency: number
	function ClearPathMarkers(self): ()
	function FindNextBallBounce(self): BallBounce
	function GetAngularVelocityAtTime(self, Time: number): Vector3
	function GetBallBounceByIndex(self, bounceIndex: number): BallBounce
	function GetBestDirectionToTargetAtTime(self, InPlaybackTime: number, InTargetPosition: Vector3, InSpeed: number, SpinAxis: Vector3, InSpinSpeed: number, InStepCount: number, InTargetRadius: number, InMaxSampleCount: number): Vector3
	function GetCFrameAtTime(self, Time: number): CFrame
	function GetCurrentPlaybackPosition(self): Vector3
	function GetCurrentSnapshotIndex(self): any
	function GetLinearVelocityAtTime(self, Time: number): Vector3
	function GetPlaybackTime(self): number
	function GetRemainedTimeForNextBounce(self): number
	function GetSpeedAtTime(self, Time: number): number
	function IsValidBounceIndex(self, bounceIndex: number): boolean
	function Pause(self): ()
	function Play(self): ()
	function ReSimulateSpinToTargetWithDelay(self, InDelayTime: number, InTargetPosition: Vector3, InSpeed: number, InSpinAxis: Vector3, InSpinSpeed: number, InStepCount: number): boolean
	function ReSimulateToTargetWithDelay(self, InDelayTime: number, InTargetPosition: Vector3, InSpeed: number, InStepCount: number): boolean
	function ReSimulateWithDelay(self, InDelayTime: number, InDirection: Vector3, InSpeed: number, InSpinAxis: Vector3, InSpinSpeed: number, InStepCount: number): ()
	function SetPlaybackTime(self, InPlaybackTime: number): ()
	function Simulate(self, InBallSimParams: BallSimParams): ()
	function Stop(self): ()
	Bounded: ScriptSignal
	Paused: ScriptSignal
	Played: ScriptSignal
	Stopped: ScriptSignal
	Touched: ScriptSignal
	TouchEnded: ScriptSignal
end

declare class ValueBase extends Instance
	Value: any
end

declare class NumberValue extends ValueBase
	Value: number
	Changed: ScriptSignal
end

declare class DataStoreKeyInfo extends Instance
	CreatedTime: number
	UpdatedTime: number
	Version: string
	function GetMetadata(self): {[string]: any}
	function GetUserIds(self): {any}
end

declare class ScrollingFrame extends GuiObject
	AbsoluteCanvasSize: Vector2
	AbsoluteWindowSize: Vector2
	AutomaticCanvasSize: AutomaticSize
	CanvasPosition: Vector2
	CanvasSize: UDim2
	ScrollBarImageColor3: Color3
	ScrollBarImageTransparency: number
	ScrollBarThickness: number
	ScrollingDirection: ScrollingDirection
	ScrollingEnabled: boolean
	function MoveToSlot(self, SlotIndex: number): ()
end

declare class Part extends BasePart
	Shape: PartType
end

declare class FormFactorPart extends Part
end

declare class BaseScript extends LuaSourceContainer
	Enabled: boolean
end

declare class Script extends BaseScript
end

declare class ActionSequence extends Instance
	function GetMarkerReachedSignal(self, MarkerName: string): ScriptSignal
	function Hit(self, InCollisionEventName: string): ScriptSignal
	function TriggerEnded(self, TriggerName: string): ScriptSignal
	function TriggerStarted(self, TriggerName: string): ScriptSignal
end

declare class StarterCharacterScripts extends Instance
end

declare class SpawnLocation extends FormFactorPart
	Enabled: boolean
	Neutral: boolean
	TeamColor: BrickColor
end

declare class Translator extends Instance
	LocaleId: string
	function FormatByKey(self, Key: string, Args: any): string
	function Translate(self, Context: Instance, Source: string): string
end

declare class VFXPreset extends Instance
	Color: ColorSequence
	Enabled: boolean
	InfiniteLoop: boolean
	LoopCount: number
	PresetName: string
	Size: number
	Transparency: number
	function Clear(self): ()
	function Emit(self, ParticleCount: number): ()
end

declare class MarketplaceService extends Instance
	ProcessReceipt: any
	function GetProductInfo(self, ProductId: number, InfoType: InfoType): any
	function GetWorldProductsAsync(self): Pages
	function PromptProductPurchase(self, Player: Player, ProductId: number): ()
	PromptProductPurchaseFinished: ScriptSignal
end

declare class Beam extends Instance
	Attachment0: Attachment
	Attachment1: Attachment
	Color: ColorSequence
	CurveSize0: number
	CurveSize1: number
	Enabled: boolean
	FaceCamera: boolean
	Texture: string
	TextureLength: number
	TextureSpeed: number
	Transparency: NumberSequence
	Width0: number
	Width1: number
end

declare class LocalScript extends BaseScript
end

declare class CollectionService extends Instance
	function AddTag(self, instance: Instance, tag: string): ()
	function GetTagged(self, tag: string): {any}
	function GetTags(self, Instance: Instance): {any}
	function HasTag(self, instance: Instance, tag: string): boolean
	function RemoveTag(self, instance: Instance, tag: string): ()
end

declare class Humanoid extends Instance
	AirControl: number
	AutomaticScalingEnabled: boolean
	CameraOffset: Vector3
	CapsuleHeight: number
	CapsuleRadius: number
	CharacterMeshPos: Vector3
	DisplayDistanceType: HumanoidDisplayDistanceType
	FallingDeceleration: number
	FallingLateralFriction: number
	GravityScale: number
	GroundFriction: number
	Health: number
	HitboxType: HitboxType
	IgnoreBaseRotation: boolean
	Jump: boolean
	JumpHeight: number
	JumpPower: number
	LookCameraDirection: boolean
	MaxAcceleration: number
	MaxHealth: number
	MaxJumpCount: number
	MaxSlopeAngle: number
	RootPart: BasePart
	RotationSpeed: number
	StompJumpMultiplier: number
	UseJumpPower: boolean
	WalkingDeceleration: number
	WalkSpeed: number
	WalkToPart: BasePart
	WalkToPoint: Vector3
	function ApplyDescription(self, InDescription: HumanoidDescription, InAssetTypeVerification: AssetTypeVerification): ()
	function ChangeState(self, StateType: HumanoidStateType): ()
	function EquipTool(self, InTool: Instance): ()
	function GetActionRunner(self): ActionRunner
	function GetAppliedDescription(self): HumanoidDescription
	function GetState(self): any
	function LoadAnimation(self, InAnimation: Animation): AnimationTrack
	function MoveTo(self, InPosition: Vector3, InWalkToPart: BasePart): ()
	function SetStateEnabled(self, InHumanoidStateType: HumanoidStateType, InEnabled: boolean): ()
	function TakeDamage(self, InDamage: number): ()
	function UnequipTools(self): ()
	Climbing: ScriptSignal
	Died: ScriptSignal
	FallingDown: ScriptSignal
	FreeFalling: ScriptSignal
	HealthChanged: ScriptSignal
	Jumping: ScriptSignal
	Landed: ScriptSignal
	MoveToFinished: ScriptSignal
	Running: ScriptSignal
	StateChanged: ScriptSignal
	Swimming: ScriptSignal
end

declare class DataStoreIncrementOptions extends Instance
	function GetMetadata(self): {[string]: any}
	function SetMetadata(self, InMetaDataTable: {[string]: any}): ()
end

declare class PhysicsService extends Instance
end

declare class CoreGui extends Instance
end

declare class ContextActionService extends Instance
	function BindAction(self, ActionName: string, FunctionToBind: any, CreateTouchButton: boolean, InputType: any): ()
	function GetAllBoundActionInfo(self): any
	function GetBoundActionInfo(self, ActionName: string): any
	function GetButton(self, ActionName: string): any
	function SetDescription(self, ActionName: string, InDescription: string): ()
	function SetImage(self, ActionName: string, ImageId: string): ()
	function SetPosition(self, ActionName: string, InPosition: UDim2): ()
	function SetTitle(self, ActionName: string, InTitle: string): ()
	function UnbindAction(self, ActionName: string): ()
	LocalToolEquipped: ScriptSignal
	LocalToolUnequipped: ScriptSignal
end

declare class Fill extends OverlayBase
	Color: Color3
	DepthMode: FillDepthModeType
	Transparency: number
end

declare class ParticleEmitter extends Instance
	Acceleration: Vector3
	Brightness: number
	Color: ColorSequence
	Drag: number
	EmissionDirection: NormalId
	Enabled: boolean
	FlipbookFramerate: NumberRange
	FlipbookLayout: ParticleFlipbookLayout
	FlipbookMode: ParticleFlipbookMode
	FlipbookStartRandom: boolean
	Lifetime: NumberRange
	LightEmission: number
	LockedToPart: boolean
	Orientation: ParticleOrientation
	Rate: number
	Rotation: NumberRange
	RotSpeed: number
	Shape: ParticleEmitterShape
	ShapeInOut: ParticleEmitterShapeInOut
	ShapeStyle: ParticleEmitterShapeStyle
	Size: NumberSequence
	Speed: NumberRange
	SpreadAngle: number
	Squash: NumberSequence
	Texture: string
	Transparency: NumberSequence
	function Clear(self): ()
	function Emit(self, ParticleCount: number): ()
end

declare class AngularVelocity extends Constraint
	AngularVelocity: Vector3
	MaxTorque: number
	ReactionTorqueEnabled: boolean
	RelativeTo: ActuatorRelativeTo
end

declare class BillboardGui extends SurfaceGuiBase
	CurrentDistance: number
	DistanceLowerLimit: number
	DistanceUpperLimit: number
	ExtentsOffsetWorldSpace: Vector3
	PlayerToHideFrom: Player
	PositionOffset: Vector3
	PositionOffsetWorldSpace: Vector3
	SizeOffset: Vector2
end

declare class TeleportAsyncResult extends Instance
	ReservedServerAccessCode: string
end

declare class GenericSettings extends ServiceProvider
end

declare class UserSettings extends GenericSettings
	GameSettings: UserGameSettings
end

declare class Sound extends Instance
	IsLoaded: boolean
	IsPaused: boolean
	IsPlaying: boolean
	Looped: boolean
	LoopRegion: NumberRange
	PlaybackLoudness: number
	PlaybackRegion: NumberRange
	PlaybackRegionsEnabled: boolean
	PlaybackSpeed: number
	Playing: boolean
	PlayOnRemove: boolean
	PreviewPlaying: boolean
	PreviewTimePosition: number
	RollOffMaxDistance: number
	RollOffMinDistance: number
	RollOffMode: RollOffMode
	SoundGroup: SoundGroup
	SoundId: string
	StartTimePosition: number
	TimeLength: number
	TimePosition: number
	Volume: number
	function Pause(self): ()
	function Play(self): ()
	function Resume(self): ()
	function Stop(self): ()
	DidLoop: ScriptSignal
	Ended: ScriptSignal
	Loaded: ScriptSignal
	Paused: ScriptSignal
	Played: ScriptSignal
	Resumed: ScriptSignal
	Stopped: ScriptSignal
end

declare class StringValue extends ValueBase
	Value: string
	Changed: ScriptSignal
end

declare class ScreenGui extends LayerCollector
	DisplayOrder: number
end

declare class ServerStorage extends Instance
end

declare class UserGameSettings extends Instance
	CharacterTurnRate: number
	RotationType: RotationType
end

declare class LocalizationService extends Instance
	ClientLocaleId: string
	SystemLocaleId: string
	function GetCountryRegionForPlayerAsync(self, Player: Instance): string
	function GetTranslatorForLocaleAsync(self, Locale: string): Translator
	function GetTranslatorForPlayerAsync(self, Player: Instance): Translator
end

declare class WrapTarget extends Instance
end

declare class RemoteEvent extends Instance
	function FireAllClients(self, Arguments: any): ()
	function FireClient(self, Player: Player, Arguments: any): ()
	function FireServer(self, Arguments: any): ()
	OnClientEvent: ScriptSignal
	OnServerEvent: ScriptSignal
end

declare class RunService extends Instance
	function IsClient(self): boolean
	function IsServer(self): boolean
	function IsStudio(self): boolean
	Heartbeat: ScriptSignal
	RenderStepped: ScriptSignal
	Stepped: ScriptSignal
end

declare class BoolValue extends ValueBase
	Value: boolean
	Changed: ScriptSignal
end

declare class SpotLight extends Light
	Angle: number
	Face: NormalId
	Range: number
end

declare class SoundGroup extends Instance
	Volume: number
end

declare class UIListLayout extends UIGridStyleLayout
	Padding: UDim
	Wraps: boolean
end

declare class TextLabel extends GuiObject
	Bold: boolean
	LocalizedText: string
	Text: string
	TextColor3: Color3
	TextScaled: boolean
	TextSize: number
	TextTransparency: number
	TextWrapped: boolean
	TextXAlignment: TextXAlignment
	TextYAlignment: TextYAlignment
end

declare class InputObject extends Instance
	Delta: Vector3
	KeyCode: KeyCode
	Position: Vector3
	UserInputState: UserInputState
	UserInputType: UserInputType
end

declare class MeshPart extends BasePart
	DoubleSided: boolean
	EnableMeshShadowDetails: boolean
	MeshId: string
	MeshShadowDetailLevel: ShadowDetailLevel
	MeshSize: Vector3
	TextureId: string
end

declare class BindableEvent extends Instance
	function Fire(self, Arguments: any): ()
	Event: ScriptSignal
end

declare class TeleportOptions extends Instance
	ReservedServerAccessCode: string
	ServerInstanceId: string
	ShouldReserveServer: boolean
end

declare class ActionRunner extends Instance
	function GetActionSequences(self): any
	function Play(self, InActionSequenceID: string, TransitionTime: number): ()
	function Stop(self, InActionSequenceID: string): ()
	function StopAll(self): ()
	Ended: ScriptSignal
	Stopped: ScriptSignal
end

declare class IntValue extends ValueBase
	Value: number
	Changed: ScriptSignal
end

declare class TweenService extends Instance
	function Create(self, Instance: Instance, TweenInfo: TweenInfo, PropertyTable: any): Instance
end

declare class DataModel extends ServiceProvider
	JobId: string
	PlaceId: string
	Workspace: Workspace
	function DisableJoin(self): ()
	function EnableJoin(self): ()
	function IsJoinEnabled(self): boolean
end

declare class Trail extends Instance
	Color: ColorSequence
	Enabled: boolean
	Lifetime: number
	Offset: Vector3
	Texture: string
	TextureLength: number
	TextureSpeed: number
	Transparency: NumberSequence
	Width: number
	WidthScale: NumberSequence
end

declare class Lighting extends Instance
	Ambient: Color3
	AmbientSkyBrightness: number
	AmbientSkyColor: Color3
	AutoTimeCycle: boolean
	Brightness: number
	ClockTime: number
	Contrast: number
	GroundReflectionColor: Color3
	MoonBrightness: number
	MoonCastShadow: boolean
	MoonLightColor: Color3
	MoonMaterialColor: Color3
	MoonMaxHeight: number
	MoonPathAngle: number
	MoonPhase: number
	NightBrightness: number
	RealTimeDayDuration: string
	Saturation: number
	ShadowDetailLevel: ShadowDetailLevel
	SkyColorInfluence: number
	StarsBrightness: number
	StarsColor: Color3
	SunBrightness: number
	SunCastShadow: boolean
	SunLightColor: Color3
	SunMaxHeight: number
	SunPathAngle: number
	TimeFlowSpeed: number
end

declare class DataStoreService extends Instance
	function GetDataStore(self, InName: string, InScope: string, InOption: Instance?): GlobalDataStore
	function GetGlobalDataStore(self): GlobalDataStore
end

declare class Team extends Instance
	TeamColor: BrickColor
end

declare class WorldRankService extends Instance
	function GetDisplayEnabled(self): boolean
	function GetScore(self, Player: Player): number
	function IncrementScore(self, Player: Player, Score: number): ()
	function SetDisplayEnabled(self, InEnableDisplay: boolean): ()
end

declare class ImageButton extends GuiButton
	HoverImage: string
	Image: string
	ImageColor3: Color3
	ImageTransparency: number
	PressImage: string
end

declare class TeleportService extends Instance
	function ReserveServerAsync(self, InPlaceId: number): string
	function TeleportAsync(self, InPlaceId: number, InPlayers: {any}, InOptions: TeleportOptions?): ()
	TeleportInitFailed: ScriptSignal
end

declare class PlayerScripts extends Instance
end

declare class DataStoreKeyPages extends Pages
	Cursor: string
end

declare class CharacterMesh extends Instance
end

declare class TextButton extends GuiButton
	Bold: boolean
	LocalizedText: string
	Text: string
	TextColor3: Color3
	TextScaled: boolean
	TextSize: number
	TextTransparency: number
	TextWrapped: boolean
	TextXAlignment: TextXAlignment
	TextYAlignment: TextYAlignment
end

declare class Folder extends Instance
end

declare class DataStoreGetOptions extends Instance
end

declare class Skeleton extends PVInstance
end

declare class Teams extends Instance
end

declare class MaterialService extends Instance
	Aspalt: string
	Bark: string
	Basic: string
	BeigeTerrazzoFloor: string
	Brick: string
	BrickCeramicTile: string
	BrokenConcrete: string
	BrokenRoof: string
	BrushMetal: string
	CementWall: string
	Chainmail: string
	CheckerTileFloor: string
	Concrete: string
	ConcretePlate: string
	Copper: string
	CorrugatedSteel: string
	CrackedMiddleCeramicTile: string
	CrackedSmallCeramicTile: string
	CrocEmbossedLeather: string
	DamagedRoof: string
	DistroyedBronze: string
	EmeraldGridTile: string
	FabricDenim: string
	FabricWeave: string
	Foil: string
	GalvanizedMetal: string
	Glass: string
	GrainLeather: string
	Grass: string
	GreyWovenFabric: string
	GridBorder: string
	GridBox: string
	GridMarble: string
	GridPentagon: string
	GridQuad: string
	GridTile: string
	Ground: string
	HalfLeafyGround: string
	HouseBricks: string
	IndustrialRibbedSteel: string
	LeafyGround: string
	Marble: string
	MatteRubber: string
	Metal: string
	MetalPlate: string
	MixRoad: string
	MosaicCarpet: string
	MossyGround: string
	MossyRock: string
	OceanPanelTile: string
	OfficeCeilingLight: string
	OfficeCeilingWhite: string
	PaintedMetal: string
	PaintedWood: string
	PaintedWornWood: string
	Paving: string
	PavingBlock: string
	PavingBrick: string
	PavingFloor: string
	PavingStones: string
	PavingWall: string
	PeelingPaintSteel: string
	Plank: string
	Plastic: string
	Road: string
	Rock: string
	Roof: string
	Rust: string
	RustBrass: string
	RustMetal: string
	RustySteel: string
	Sand: string
	SandstoneBrick: string
	SilverMetal: string
	SmallBrick: string
	Snow: string
	SoilRockGround: string
	SquareCeramicTile: string
	StoneBrick: string
	StoneFloor: string
	TakenOffCeramicTile: string
	Tatami: string
	TerrazzoFloor: string
	ThickCarpet: string
	Unlit: string
	UrbanSlateFloor: string
	WeatheredPlasterBrick: string
	WhiteCementBrick: string
	WhiteGrayBrick: string
	Wood: string
	WoodLogSidingWall: string
	WoodSidingWall: string
	WoodTileFloor: string
	function GetBaseMaterialOverride(self, InMaterial: Material): string
	function GetMaterialVariant(self, InMaterial: Material, InName: string): MaterialVariant
	function SetBaseMaterialOverride(self, InMaterial: Material, InName: string): ()
end

declare class VectorForce extends Constraint
	ApplyAtCenterOfMass: boolean
	Force: Vector3
	RelativeTo: ActuatorRelativeTo
end

declare class UIAspectRatioConstraint extends Instance
	AspectRatio: number
	AspectType: AspectType
	DominantAxis: DominantAxis
end

declare class ReplicatedStorage extends Instance
end

declare class ActionSequenceService extends Instance
end

declare class HumanoidDescription extends Instance
	AccessoryBlob: string
	BackAccessory: string
	BodyTypeScale: number
	ClimbAnimation: string
	DepthScale: number
	DieAnimation: string
	Face: string
	FaceAccessory: string
	FallAnimation: string
	FrontAccessory: string
	GraphicTShirt: string
	HairAccessory: string
	HatAccessory: string
	Head: string
	HeadColor: Color3
	HeadScale: number
	HeadTextureId: string
	HeightScale: number
	IdleAnimation: string
	IdleVariations: {any}
	JumpAnimation: string
	LandedAnimation: string
	LeftArm: string
	LeftArmColor: Color3
	LeftArmTextureId: string
	LeftLeg: string
	LeftLegColor: Color3
	LeftLegTextureId: string
	MoodAnimation: string
	NeckAccessory: string
	Pants: string
	ProportionScale: number
	RightArm: string
	RightArmColor: Color3
	RightArmTextureId: string
	RightLeg: string
	RightLegColor: Color3
	RightLegTextureId: string
	RunAnimation: string
	Shirt: string
	ShoulderAccessory: string
	SprintAnimation: string
	SwimmingBreaststrokeAnimation: string
	SwimmingIdleAnimation: string
	Torso: string
	TorsoColor: Color3
	TorsoTextureId: string
	WaistAccessory: string
	WalkAnimation: string
	WidthScale: number
	function AddEmote(self, InName: string, InAssetId: string): ()
	function GetAccessories(self, InIncludeRigidAccessories: boolean?): any
	function GetEmotes(self): any
	function GetEquippedEmotes(self): any
	function RemoveEmote(self, InName: string): ()
	function SetAccessories(self, InAccessories: {any}, InIncludeRigidAccessories: boolean?): ()
	function SetEmotes(self, InEmotes: any): ()
	function SetEquippedEmotes(self, InEquippedEmotes: {any}): ()
end

declare class PlayerGui extends Instance
end

-- Globals
declare game: DataModel
declare workspace: Workspace
declare script: BaseScript

declare Instance: {
	new: (className: "Part") -> Part,
	new: (className: "MeshPart") -> MeshPart,
	new: (className: "Model") -> Model,
	new: (className: "Folder") -> Folder,
	new: (className: "BillboardGui") -> BillboardGui,
	new: (className: "ScreenGui") -> ScreenGui,
	new: (className: "SurfaceGui") -> SurfaceGui,
	new: (className: "Frame") -> Frame,
	new: (className: "TextLabel") -> TextLabel,
	new: (className: "TextButton") -> TextButton,
	new: (className: "ImageLabel") -> ImageLabel,
	new: (className: "ImageButton") -> ImageButton,
	new: (className: "Script") -> Script,
	new: (className: "LocalScript") -> LocalScript,
	new: (className: "ModuleScript") -> ModuleScript,
	new: (className: "Sound") -> Sound,
	new: (className: "ParticleEmitter") -> ParticleEmitter,
	new: (className: "Light") -> Light,
	new: (className: "Attachment") -> Attachment,
	new: (className: "Animation") -> Animation,
	new: (className: "Animator") -> Animator,
	new: (className: "Humanoid") -> Humanoid,
	new: (className: "IntValue") -> IntValue,
	new: (className: "StringValue") -> StringValue,
	new: (className: "BoolValue") -> BoolValue,
	new: (className: "NumberValue") -> NumberValue,
	new: (className: string) -> Instance,
}

declare task: {
	wait: (duration: number?) -> number,
	spawn: <A...>(fn: (A...) -> (), A...) -> thread,
	delay: <A...>(duration: number, fn: (A...) -> (), A...) -> thread,
	cancel: (thread: thread) -> (),
	defer: <A...>(fn: (A...) -> (), A...) -> thread,
}

declare function isnil(value: any): boolean
declare function wait(seconds: number?): number
