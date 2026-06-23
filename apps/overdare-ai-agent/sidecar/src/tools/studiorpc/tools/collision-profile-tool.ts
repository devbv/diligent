// @summary Manages collision channels and profiles stored in .ovdrjm WorldProfileData.

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";
import { isRecord, readAndWriteOvdrjm, readOvdrjmDocument } from "./ovdrjm-utils";

const collisionResponseSchema = z.enum(["ECR_Block", "ECR_Overlap", "ECR_Ignore"]);
const collisionEnabledSchema = z.enum(["NoCollision", "QueryOnly", "PhysicsOnly", "QueryAndPhysics"]);
const nameSchema = z.string().min(1).max(50);
const customResponseSchema = z
  .object({
    channel: z.string().min(1).describe("Collision channel name, such as WorldStatic or a custom channel name."),
    response: collisionResponseSchema,
  })
  .strict();

const emptyParams = z.object({}).strict();

const addChannelParams = z
  .object({
    channel: z.string().min(1).describe("Unused ECC_GameTraceChannel1 through ECC_GameTraceChannel18 value."),
    name: nameSchema.describe("Unique collision channel name."),
    defaultResponse: collisionResponseSchema,
    bTraceType: z.boolean(),
    bStaticObject: z.boolean(),
  })
  .strict();

const updateChannelParams = z
  .object({
    channel: z.string().min(1).describe("Collision channel identifier to update."),
    name: nameSchema.optional(),
    defaultResponse: collisionResponseSchema.optional(),
    bTraceType: z.boolean().optional(),
    bStaticObject: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.defaultResponse !== undefined ||
      value.bTraceType !== undefined ||
      value.bStaticObject !== undefined,
    { message: "At least one channel field must be provided." },
  );

const deleteChannelParams = z
  .object({
    channel: z.string().min(1).describe("Collision channel identifier to delete."),
  })
  .strict();

const createProfileParams = z
  .object({
    name: nameSchema.describe("Unique custom collision profile name."),
    collisionEnabled: collisionEnabledSchema.default("QueryAndPhysics"),
    objectTypeName: z.string().min(1).describe("Object type channel name for this profile."),
    customResponses: z.array(customResponseSchema).optional(),
    helpMessage: z.string().optional(),
    bCanModify: z.boolean().optional().describe("Ignored. Custom profiles are always written with bCanModify: true."),
  })
  .strict();

const updateProfileParams = z
  .object({
    name: nameSchema.describe("Collision profile name to update."),
    collisionEnabled: collisionEnabledSchema.optional(),
    objectTypeName: z.string().min(1).optional(),
    customResponses: z.array(customResponseSchema).optional(),
    helpMessage: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.collisionEnabled !== undefined ||
      value.objectTypeName !== undefined ||
      value.customResponses !== undefined ||
      value.helpMessage !== undefined,
    { message: "At least one profile field must be provided." },
  );

const deleteProfileParams = z
  .object({
    name: nameSchema.describe("Custom collision profile name to delete."),
  })
  .strict();

type CustomResponse = z.infer<typeof customResponseSchema>;
type CollisionChannelInput = z.infer<typeof addChannelParams>;
type CreateProfileInput = z.infer<typeof createProfileParams>;
type UpdateProfileInput = z.infer<typeof updateProfileParams>;

type WorldProfileData = Record<string, unknown>;

type DefaultProfileDefinition = {
  name: string;
  objectTypeName: string;
  collisionEnabled: z.infer<typeof collisionEnabledSchema>;
  customResponses: CustomResponse[];
  helpMessage?: string;
};

class CollisionToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CollisionToolError";
  }
}

const DEFAULT_CHANNELS = [
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

const DEFAULT_CHANNEL_NAMES: Set<string> = new Set(DEFAULT_CHANNELS.map((channel) => channel.name));
const DEFAULT_CHANNEL_IDS: Set<string> = new Set(DEFAULT_CHANNELS.map((channel) => channel.channel));
const DEFAULT_OBJECT_TYPE_NAMES: Set<string> = new Set(
  DEFAULT_CHANNELS.filter((channel) => !channel.bTraceType).map((channel) => channel.name),
);

const DEFAULT_PROFILE_DEFINITIONS: DefaultProfileDefinition[] = [
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
  { name: "Ragboll", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Vehicle", objectTypeName: "Vehicle", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "UI", objectTypeName: "WorldDynamic", collisionEnabled: "QueryOnly", customResponses: [] },
  { name: "Debris", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "Projectile", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "RootPart", objectTypeName: "Pawn", collisionEnabled: "QueryAndPhysics", customResponses: [] },
  { name: "BodyPart", objectTypeName: "PhysicsBody", collisionEnabled: "QueryAndPhysics", customResponses: [] },
];

const DEFAULT_PROFILE_NAMES: Set<string> = new Set([
  ...DEFAULT_PROFILE_DEFINITIONS.map((profile) => profile.name),
  "Ragdoll",
]);

function isCustomChannelId(value: string): boolean {
  const match = /^ECC_GameTraceChannel(\d+)$/.exec(value);
  if (!match) return false;
  const channelNumber = Number(match[1]);
  return Number.isInteger(channelNumber) && channelNumber >= 1 && channelNumber <= 18;
}

function getWorldProfileData(document: Record<string, unknown>): WorldProfileData {
  const data = document.WorldProfileData;
  if (!isRecord(data) || Array.isArray(data)) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", "WorldProfileData is missing or invalid.");
  }
  return data;
}

function getRecordArray(data: WorldProfileData, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && !Array.isArray(item))) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `WorldProfileData.${key} must be an array.`);
  }
  return value as Record<string, unknown>[];
}

function ensureRecordArray(data: WorldProfileData, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (value === undefined) {
    const created: Record<string, unknown>[] = [];
    data[key] = created;
    return created;
  }
  return getRecordArray(data, key);
}

function getEditProfiles(data: WorldProfileData): Record<string, unknown> {
  const value = data.EditProfiles;
  if (value === undefined) return {};
  if (!isRecord(value) || Array.isArray(value)) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", "WorldProfileData.EditProfiles must be an object.");
  }
  return value;
}

function ensureEditProfiles(data: WorldProfileData): Record<string, unknown> {
  const value = data.EditProfiles;
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    data.EditProfiles = created;
    return created;
  }
  return getEditProfiles(data);
}

function getCustomResponses(container: Record<string, unknown>, path: string): Record<string, unknown>[] {
  const value = container.customResponses;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && !Array.isArray(item))) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `${path}.customResponses must be an array.`);
  }
  return value as Record<string, unknown>[];
}

function channelDisplayName(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  if (typeof entry.channel === "string" && entry.channel.startsWith("ECC_")) return entry.channel.slice(4);
  return undefined;
}

function isCustomChannelEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.channel === "string" && isCustomChannelId(entry.channel);
}

function channelNameSet(data: WorldProfileData): Set<string> {
  const names = new Set(DEFAULT_CHANNEL_NAMES);
  for (const entry of getRecordArray(data, "DefaultChannelResponses")) {
    const name = channelDisplayName(entry);
    if (name) names.add(name);
  }
  return names;
}

function objectTypeNameSet(data: WorldProfileData): Set<string> {
  const names = new Set(DEFAULT_OBJECT_TYPE_NAMES);
  for (const entry of getRecordArray(data, "DefaultChannelResponses")) {
    if (entry.bTraceType !== false) continue;
    const name = channelDisplayName(entry);
    if (name) names.add(name);
  }
  return names;
}

function hasChannelName(data: WorldProfileData, name: string, excludeChannel?: string): boolean {
  if (DEFAULT_CHANNEL_NAMES.has(name)) return true;
  return getRecordArray(data, "DefaultChannelResponses").some((entry) => {
    if (excludeChannel !== undefined && entry.channel === excludeChannel) return false;
    return channelDisplayName(entry) === name;
  });
}

function findChannelEntry(
  entries: Record<string, unknown>[],
  channel: string,
): { entry: Record<string, unknown>; index: number } | undefined {
  const index = entries.findIndex((entry) => entry.channel === channel);
  if (index === -1) return undefined;
  return { entry: entries[index], index };
}

function isKnownProtectedChannelIdentifier(value: string): boolean {
  return (
    DEFAULT_CHANNEL_NAMES.has(value) ||
    DEFAULT_CHANNEL_IDS.has(value) ||
    (value.startsWith("ECC_") && !isCustomChannelId(value))
  );
}

function validateCustomResponses(responses: CustomResponse[], data: WorldProfileData): void {
  const validChannels = channelNameSet(data);
  const seen = new Set<string>();
  for (const response of responses) {
    if (!validChannels.has(response.channel)) {
      throw new CollisionToolError("INVALID_CHANNEL", `Unknown collision channel: ${response.channel}`);
    }
    if (seen.has(response.channel)) {
      throw new CollisionToolError(
        "INVALID_CHANNEL",
        `customResponses contains duplicate channel: ${response.channel}`,
      );
    }
    seen.add(response.channel);
  }
}

function validateObjectTypeName(objectTypeName: string, data: WorldProfileData): void {
  if (!objectTypeNameSet(data).has(objectTypeName)) {
    throw new CollisionToolError(
      "INVALID_CHANNEL",
      `${objectTypeName} is not a valid object type channel. Use a default object type or a custom non-trace channel.`,
    );
  }
}

function findCustomProfile(
  profiles: Record<string, unknown>[],
  name: string,
): { profile: Record<string, unknown>; index: number } | undefined {
  const index = profiles.findIndex((profile) => profile.name === name);
  if (index === -1) return undefined;
  return { profile: profiles[index], index };
}

function hasProfileName(data: WorldProfileData, name: string, excludeName?: string): boolean {
  if (DEFAULT_PROFILE_NAMES.has(name) && name !== excludeName) return true;
  return getRecordArray(data, "Profiles").some((profile) => profile.name === name && profile.name !== excludeName);
}

function syncCustomResponseChannelNames(
  data: WorldProfileData,
  oldName: string,
  newName: string,
): { profilesUpdated: number; responsesUpdated: number } {
  let profilesUpdated = 0;
  let responsesUpdated = 0;

  for (const profile of getRecordArray(data, "Profiles")) {
    const responses = getCustomResponses(profile, `Profiles.${String(profile.name ?? "<unknown>")}`);
    let profileChanged = false;
    for (const response of responses) {
      if (response.channel !== oldName) continue;
      response.channel = newName;
      profileChanged = true;
      responsesUpdated++;
    }
    if (profileChanged) profilesUpdated++;
  }

  for (const [profileName, editProfile] of Object.entries(getEditProfiles(data))) {
    if (!isRecord(editProfile) || Array.isArray(editProfile)) {
      throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `EditProfiles.${profileName} must be an object.`);
    }
    const responses = getCustomResponses(editProfile, `EditProfiles.${profileName}`);
    let profileChanged = false;
    for (const response of responses) {
      if (response.channel !== oldName) continue;
      response.channel = newName;
      profileChanged = true;
      responsesUpdated++;
    }
    if (profileChanged) profilesUpdated++;
  }

  return { profilesUpdated, responsesUpdated };
}

function syncProfileObjectTypeNames(
  data: WorldProfileData,
  oldName: string,
  newName: string,
): { profilesUpdated: number } {
  let profilesUpdated = 0;
  for (const profile of getRecordArray(data, "Profiles")) {
    if (profile.objectTypeName !== oldName) continue;
    profile.objectTypeName = newName;
    profilesUpdated++;
  }
  return { profilesUpdated };
}

function profilesUsingObjectType(data: WorldProfileData, objectTypeName: string): string[] {
  return getRecordArray(data, "Profiles")
    .filter((profile) => profile.objectTypeName === objectTypeName)
    .map((profile) => (typeof profile.name === "string" ? profile.name : "<unnamed>"));
}

function removeCustomResponseChannel(
  data: WorldProfileData,
  channelName: string,
): { profilesUpdated: number; responsesRemoved: number } {
  let profilesUpdated = 0;
  let responsesRemoved = 0;

  for (const profile of getRecordArray(data, "Profiles")) {
    const responses = getCustomResponses(profile, `Profiles.${String(profile.name ?? "<unknown>")}`);
    const kept = responses.filter((response) => response.channel !== channelName);
    if (kept.length === responses.length) continue;
    profile.customResponses = kept;
    profilesUpdated++;
    responsesRemoved += responses.length - kept.length;
  }

  for (const [profileName, editProfile] of Object.entries(getEditProfiles(data))) {
    if (!isRecord(editProfile) || Array.isArray(editProfile)) {
      throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `EditProfiles.${profileName} must be an object.`);
    }
    const responses = getCustomResponses(editProfile, `EditProfiles.${profileName}`);
    const kept = responses.filter((response) => response.channel !== channelName);
    if (kept.length === responses.length) continue;
    editProfile.customResponses = kept;
    profilesUpdated++;
    responsesRemoved += responses.length - kept.length;
  }

  return { profilesUpdated, responsesRemoved };
}

function buildProfilesPayload(data: WorldProfileData): {
  defaultProfiles: Array<DefaultProfileDefinition & { bCanModify: false }>;
  customProfiles: Record<string, unknown>[];
} {
  const editProfiles = getEditProfiles(data);
  const defaultProfiles = DEFAULT_PROFILE_DEFINITIONS.map((profile) => {
    const editProfile = editProfiles[profile.name];
    const customResponses =
      isRecord(editProfile) && !Array.isArray(editProfile)
        ? (getCustomResponses(editProfile, `EditProfiles.${profile.name}`) as CustomResponse[])
        : profile.customResponses;

    return {
      ...profile,
      customResponses,
      bCanModify: false as const,
    };
  });

  const customProfiles = getRecordArray(data, "Profiles").map((profile) => ({
    ...profile,
    bCanModify: profile.bCanModify === undefined ? true : profile.bCanModify,
  }));

  return { defaultProfiles, customProfiles };
}

function okResult(payload: unknown, metadata: Record<string, unknown> = {}): ToolResult {
  return {
    output: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    metadata: { ...metadata, result: payload },
  };
}

function errorResult(error: unknown, toolName: string): ToolResult {
  if (error instanceof CollisionToolError) {
    const payload = { success: false, error: { code: error.code, message: error.message } };
    return {
      output: JSON.stringify(payload, null, 2),
      metadata: { error: true, toolName, code: error.code, message: error.message },
    };
  }
  if (error instanceof z.ZodError) {
    const code = error.issues.some((issue) => {
      const lastPath = issue.path.at(-1);
      return issue.code === "invalid_enum_value" && (lastPath === "response" || lastPath === "defaultResponse");
    })
      ? "INVALID_RESPONSE"
      : "INVALID_CHANNEL";
    const message = error.issues.map((issue) => issue.message).join("; ");
    const payload = { success: false, error: { code, message } };
    return {
      output: JSON.stringify(payload, null, 2),
      metadata: { error: true, toolName, code, message },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const payload = { success: false, error: { code: "ERROR", message } };
  return {
    output: JSON.stringify(payload, null, 2),
    metadata: { error: true, toolName, code: "ERROR", message },
  };
}

async function approveWrite(
  ctx: ToolContext,
  toolName: string,
  description: string,
  details: Record<string, unknown>,
): Promise<ToolResult | undefined> {
  const approval = await ctx.approve({
    permission: "write",
    toolName,
    description,
    details,
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true, toolName } };
  }
  return undefined;
}

function getCollisionChannels(cwd: string): ToolResult {
  try {
    const { ovdrjmPath, document } = readOvdrjmDocument(cwd);
    const data = getWorldProfileData(document);
    const channels = getRecordArray(data, "DefaultChannelResponses");
    const payload = {
      defaultChannels: channels.filter((entry) => !isCustomChannelEntry(entry)),
      customChannels: channels.filter((entry) => isCustomChannelEntry(entry)),
    };
    return okResult(payload, { toolName: "get_collision_channels", ovdrjmPath });
  } catch (error) {
    return errorResult(error, "get_collision_channels");
  }
}

async function addCollisionChannel(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "add_collision_channel";
  try {
    const parsed = addChannelParams.parse(args);
    const rejected = await approveWrite(ctx, toolName, "Add collision channel to .ovdrjm WorldProfileData", parsed);
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        const channels = ensureRecordArray(data, "DefaultChannelResponses");
        validateNewChannel(parsed, data, channels);

        const added: CollisionChannelInput = {
          channel: parsed.channel,
          defaultResponse: parsed.defaultResponse,
          bTraceType: parsed.bTraceType,
          bStaticObject: parsed.bStaticObject,
          name: parsed.name,
        };
        channels.push(added);
        return { added };
      });
      return okResult(
        { channel: fileResult.added, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

function validateNewChannel(
  parsed: CollisionChannelInput,
  data: WorldProfileData,
  channels: Record<string, unknown>[],
): void {
  if (!isCustomChannelId(parsed.channel)) {
    throw new CollisionToolError(
      "INVALID_CHANNEL",
      "Custom channels must use ECC_GameTraceChannel1 through ECC_GameTraceChannel18.",
    );
  }
  if (findChannelEntry(channels, parsed.channel)) {
    throw new CollisionToolError("DUPLICATE_NAME", `Collision channel already exists: ${parsed.channel}`);
  }
  if (channels.filter((entry) => isCustomChannelEntry(entry)).length >= 18) {
    throw new CollisionToolError("CHANNEL_LIMIT_EXCEEDED", "Custom collision channels are limited to 18 entries.");
  }
  if (hasChannelName(data, parsed.name)) {
    throw new CollisionToolError("DUPLICATE_NAME", `Collision channel name already exists: ${parsed.name}`);
  }
}

async function updateCollisionChannel(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "update_collision_channel";
  try {
    const parsed = updateChannelParams.parse(args);
    const rejected = await approveWrite(ctx, toolName, "Update collision channel in .ovdrjm WorldProfileData", parsed);
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        const channels = ensureRecordArray(data, "DefaultChannelResponses");
        const target = findChannelEntry(channels, parsed.channel);
        if (!target) {
          if (isKnownProtectedChannelIdentifier(parsed.channel)) {
            throw new CollisionToolError("PROTECTED_CHANNEL", `Default channel cannot be modified: ${parsed.channel}`);
          }
          throw new CollisionToolError("CHANNEL_NOT_FOUND", `Collision channel not found: ${parsed.channel}`);
        }
        if (!isCustomChannelEntry(target.entry)) {
          throw new CollisionToolError("PROTECTED_CHANNEL", `Default channel cannot be modified: ${parsed.channel}`);
        }

        const oldName = channelDisplayName(target.entry);
        if (!oldName) {
          throw new CollisionToolError("INVALID_CHANNEL", `Collision channel has no name: ${parsed.channel}`);
        }
        if (parsed.name !== undefined && parsed.name !== oldName && hasChannelName(data, parsed.name, parsed.channel)) {
          throw new CollisionToolError("DUPLICATE_NAME", `Collision channel name already exists: ${parsed.name}`);
        }
        const objectTypeUsers = profilesUsingObjectType(data, oldName);
        if (parsed.bTraceType === true && objectTypeUsers.length > 0) {
          throw new CollisionToolError(
            "INVALID_CHANNEL",
            `Cannot change ${oldName} to a trace channel because it is used as objectTypeName by profiles: ${objectTypeUsers.join(", ")}`,
          );
        }

        if (parsed.name !== undefined) target.entry.name = parsed.name;
        if (parsed.defaultResponse !== undefined) target.entry.defaultResponse = parsed.defaultResponse;
        if (parsed.bTraceType !== undefined) target.entry.bTraceType = parsed.bTraceType;
        if (parsed.bStaticObject !== undefined) target.entry.bStaticObject = parsed.bStaticObject;

        const customResponseSync =
          parsed.name !== undefined && parsed.name !== oldName
            ? syncCustomResponseChannelNames(data, oldName, parsed.name)
            : { profilesUpdated: 0, responsesUpdated: 0 };
        const objectTypeSync =
          parsed.name !== undefined && parsed.name !== oldName && target.entry.bTraceType === false
            ? syncProfileObjectTypeNames(data, oldName, parsed.name)
            : { profilesUpdated: 0 };

        return {
          updated: target.entry,
          sync: { ...customResponseSync, objectTypeNamesUpdated: objectTypeSync.profilesUpdated },
        };
      });
      return okResult(
        { channel: fileResult.updated, sync: fileResult.sync, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

async function deleteCollisionChannel(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "delete_collision_channel";
  try {
    const parsed = deleteChannelParams.parse(args);
    const rejected = await approveWrite(
      ctx,
      toolName,
      "Delete collision channel from .ovdrjm WorldProfileData",
      parsed,
    );
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        const channels = ensureRecordArray(data, "DefaultChannelResponses");
        const target = findChannelEntry(channels, parsed.channel);
        if (!target) {
          if (isKnownProtectedChannelIdentifier(parsed.channel)) {
            throw new CollisionToolError("PROTECTED_CHANNEL", `Default channel cannot be deleted: ${parsed.channel}`);
          }
          throw new CollisionToolError("CHANNEL_NOT_FOUND", `Collision channel not found: ${parsed.channel}`);
        }
        if (!isCustomChannelEntry(target.entry)) {
          throw new CollisionToolError("PROTECTED_CHANNEL", `Default channel cannot be deleted: ${parsed.channel}`);
        }

        const deletedName = channelDisplayName(target.entry);
        if (!deletedName) {
          throw new CollisionToolError("INVALID_CHANNEL", `Collision channel has no name: ${parsed.channel}`);
        }
        const objectTypeUsers = profilesUsingObjectType(data, deletedName);
        if (objectTypeUsers.length > 0) {
          throw new CollisionToolError(
            "INVALID_CHANNEL",
            `Cannot delete ${deletedName} because it is used as objectTypeName by profiles: ${objectTypeUsers.join(", ")}`,
          );
        }
        channels.splice(target.index, 1);
        const cleanup = removeCustomResponseChannel(data, deletedName);
        return { deleted: target.entry, cleanup };
      });
      return okResult(
        { channel: fileResult.deleted, cleanup: fileResult.cleanup, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

function getCollisionProfiles(cwd: string): ToolResult {
  try {
    const { ovdrjmPath, document } = readOvdrjmDocument(cwd);
    const data = getWorldProfileData(document);
    return okResult(buildProfilesPayload(data), { toolName: "get_collision_profiles", ovdrjmPath });
  } catch (error) {
    return errorResult(error, "get_collision_profiles");
  }
}

async function createCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "create_collision_profile";
  try {
    const parsed = createProfileParams.parse(args);
    const rejected = await approveWrite(ctx, toolName, "Create collision profile in .ovdrjm WorldProfileData", parsed);
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        const profiles = ensureRecordArray(data, "Profiles");
        validateNewProfile(parsed, data);

        const profile: Record<string, unknown> = {
          name: parsed.name,
          collisionEnabled: parsed.collisionEnabled,
          bCanModify: true,
          objectTypeName: parsed.objectTypeName,
          customResponses: parsed.customResponses ?? [],
        };
        if (parsed.helpMessage !== undefined) profile.helpMessage = parsed.helpMessage;
        profiles.push(profile);
        return { created: profile };
      });
      return okResult(
        { profile: fileResult.created, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

function validateNewProfile(parsed: CreateProfileInput, data: WorldProfileData): void {
  if (hasProfileName(data, parsed.name)) {
    throw new CollisionToolError("DUPLICATE_NAME", `Collision profile name already exists: ${parsed.name}`);
  }
  validateObjectTypeName(parsed.objectTypeName, data);
  validateCustomResponses(parsed.customResponses ?? [], data);
}

async function updateCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "edit_collision_profile";
  try {
    const parsed = updateProfileParams.parse(args);
    const rejected = await approveWrite(ctx, toolName, "Update collision profile in .ovdrjm WorldProfileData", parsed);
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        if (parsed.customResponses !== undefined) validateCustomResponses(parsed.customResponses, data);

        if (DEFAULT_PROFILE_NAMES.has(parsed.name)) {
          return updateDefaultProfile(parsed, data);
        }

        const profiles = ensureRecordArray(data, "Profiles");
        const target = findCustomProfile(profiles, parsed.name);
        if (!target) {
          throw new CollisionToolError("PROFILE_NOT_FOUND", `Collision profile not found: ${parsed.name}`);
        }
        if (parsed.objectTypeName !== undefined) validateObjectTypeName(parsed.objectTypeName, data);

        if (parsed.collisionEnabled !== undefined) target.profile.collisionEnabled = parsed.collisionEnabled;
        if (parsed.objectTypeName !== undefined) target.profile.objectTypeName = parsed.objectTypeName;
        if (parsed.customResponses !== undefined) target.profile.customResponses = parsed.customResponses;
        if (parsed.helpMessage !== undefined) {
          if (parsed.helpMessage === null) delete target.profile.helpMessage;
          else target.profile.helpMessage = parsed.helpMessage;
        }
        target.profile.bCanModify = true;

        return { updated: target.profile, storedIn: "Profiles" };
      });
      return okResult(
        { profile: fileResult.updated, storedIn: fileResult.storedIn, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

function updateDefaultProfile(
  parsed: UpdateProfileInput,
  data: WorldProfileData,
): { updated: Record<string, unknown>; storedIn: "EditProfiles" } {
  if (
    parsed.collisionEnabled !== undefined ||
    parsed.objectTypeName !== undefined ||
    parsed.helpMessage !== undefined
  ) {
    throw new CollisionToolError(
      "PROTECTED_PROFILE",
      "Default profiles only allow customResponses updates through EditProfiles.",
    );
  }
  if (parsed.customResponses === undefined) {
    throw new CollisionToolError("NO_UPDATES", "Default profile update requires customResponses.");
  }

  const editProfiles = ensureEditProfiles(data);
  const current = editProfiles[parsed.name];
  const editProfile = isRecord(current) && !Array.isArray(current) ? current : {};
  editProfile.customResponses = parsed.customResponses;
  editProfiles[parsed.name] = editProfile;
  return { updated: editProfile, storedIn: "EditProfiles" };
}

async function deleteCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
): Promise<ToolResult> {
  const toolName = "delete_collision_profile";
  try {
    const parsed = deleteProfileParams.parse(args);
    const rejected = await approveWrite(
      ctx,
      toolName,
      "Delete collision profile from .ovdrjm WorldProfileData",
      parsed,
    );
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        if (DEFAULT_PROFILE_NAMES.has(parsed.name)) {
          throw new CollisionToolError("PROTECTED_PROFILE", `Default profile cannot be deleted: ${parsed.name}`);
        }

        const profiles = ensureRecordArray(data, "Profiles");
        const target = findCustomProfile(profiles, parsed.name);
        if (!target) {
          throw new CollisionToolError("PROFILE_NOT_FOUND", `Collision profile not found: ${parsed.name}`);
        }
        profiles.splice(target.index, 1);
        return { deleted: target.profile };
      });
      return okResult(
        { profile: fileResult.deleted, ovdrjmPath: fileResult.ovdrjmPath },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

export function createCollisionProfileTools(cwd: string, writeLock: WriteLock): Tool[] {
  return [
    {
      name: "get_collision_channels",
      description: "Read all collision channels from WorldProfileData.DefaultChannelResponses.",
      parameters: emptyParams,
      async execute() {
        return getCollisionChannels(cwd);
      },
    },
    {
      name: "add_collision_channel",
      description: "Add a custom ECC_GameTraceChannel collision channel to WorldProfileData.DefaultChannelResponses.",
      parameters: addChannelParams,
      async execute(args, ctx) {
        return addCollisionChannel(args, ctx, cwd, writeLock);
      },
    },
    {
      name: "update_collision_channel",
      description:
        "Update a custom collision channel and synchronize renamed channel references in profile customResponses.",
      parameters: updateChannelParams,
      async execute(args, ctx) {
        return updateCollisionChannel(args, ctx, cwd, writeLock);
      },
    },
    {
      name: "delete_collision_channel",
      description:
        "Delete a custom collision channel and remove matching channel responses from all collision profiles.",
      parameters: deleteChannelParams,
      async execute(args, ctx) {
        return deleteCollisionChannel(args, ctx, cwd, writeLock);
      },
    },
    {
      name: "get_collision_profiles",
      description: "Read default and custom collision profiles from WorldProfileData.",
      parameters: emptyParams,
      async execute() {
        return getCollisionProfiles(cwd);
      },
    },
    {
      name: "create_collision_profile",
      description: "Create a custom collision profile in WorldProfileData.Profiles.",
      parameters: createProfileParams,
      async execute(args, ctx) {
        return createCollisionProfile(args, ctx, cwd, writeLock);
      },
    },
    {
      name: "edit_collision_profile",
      description:
        "Update a custom collision profile, or update customResponses for a default profile through EditProfiles.",
      parameters: updateProfileParams,
      async execute(args, ctx) {
        return updateCollisionProfile(args, ctx, cwd, writeLock);
      },
    },
    {
      name: "delete_collision_profile",
      description: "Delete a custom collision profile from WorldProfileData.Profiles.",
      parameters: deleteProfileParams,
      async execute(args, ctx) {
        return deleteCollisionProfile(args, ctx, cwd, writeLock);
      },
    },
  ];
}
