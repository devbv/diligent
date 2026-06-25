// @summary Built-in collision channel and profile definitions used by collision profile tools.

import type { z } from "zod";
import type { CustomResponse, collisionEnabledSchema } from "./schemas";

export type WorldProfileData = Record<string, unknown>;

export type DefaultProfileDefinition = {
  name: string;
  objectTypeName: string;
  collisionEnabled: z.infer<typeof collisionEnabledSchema>;
  customResponses: CustomResponse[];
  helpMessage?: string;
};

export const DEFAULT_CHANNELS = [
  { channel: "ECC_WorldStatic", name: "WorldStatic", bTraceType: false },
  { channel: "ECC_WorldDynamic", name: "WorldDynamic", bTraceType: false },
  { channel: "ECC_PhysicsBody", name: "PhysicsBody", bTraceType: false },
  { channel: "ECC_Pawn", name: "Pawn", bTraceType: false },
  { channel: "ECC_Visibility", name: "Visibility", bTraceType: true },
  { channel: "ECC_Camera", name: "Camera", bTraceType: true },
  { channel: "ECC_Vehicle", name: "Vehicle", bTraceType: false },
  { channel: "ECC_Destructible", name: "Destructible", bTraceType: false },
  { channel: "ECC_WeaponTrace", name: "WeaponTrace", bTraceType: true },
  { channel: "ECC_InteractionTrace", name: "InteractionTrace", bTraceType: true },
] as const;

export const DEFAULT_CHANNEL_NAMES: Set<string> = new Set(DEFAULT_CHANNELS.map((channel) => channel.name));
export const DEFAULT_CHANNEL_IDS: Set<string> = new Set(DEFAULT_CHANNELS.map((channel) => channel.channel));
export const DEFAULT_OBJECT_TYPE_NAMES: Set<string> = new Set(
  DEFAULT_CHANNELS.filter((channel) => !channel.bTraceType).map((channel) => channel.name),
);

export const DEFAULT_PROFILE_DEFINITIONS: DefaultProfileDefinition[] = [
  { name: "NoCollision", objectTypeName: "WorldStatic", collisionEnabled: "NoCollision", customResponses: [] },
  { name: "BlockAll", objectTypeName: "WorldStatic", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "OverlapAll", objectTypeName: "WorldStatic", collisionEnabled: "QueryOnly", customResponses: [] },
  {
    name: "BlockAllDynamic",
    objectTypeName: "WorldDynamic",
    collisionEnabled: "QueryAndPhysics",
    customResponses: [],
  },
  { name: "OverlapAllDynamic", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "IgnoreOnlyPawn", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "OverlapOnlyPawn", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "Pawn", objectTypeName: "Pawn", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Spectator", objectTypeName: "Pawn", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "CharacterMesh", objectTypeName: "Pawn", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "PhysicsActor", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Destructible", objectTypeName: "Destructible", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "InvisibleWall", objectTypeName: "WorldStatic", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  {
    name: "InvisibleWallDynamic",
    objectTypeName: "WorldDynamic",
    collisionEnabled: "QueryAndPhysics",
    customResponses: [],
  },
  { name: "Trigger", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "Ragdoll", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Vehicle", objectTypeName: "Vehicle", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "UI", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "Debris", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Projectile", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "RootPart", objectTypeName: "Pawn", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "BodyPart", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
];

export const DEFAULT_PROFILE_NAMES: Set<string> = new Set([
  ...DEFAULT_PROFILE_DEFINITIONS.map((profile) => profile.name),
  "Ragboll",
]);
