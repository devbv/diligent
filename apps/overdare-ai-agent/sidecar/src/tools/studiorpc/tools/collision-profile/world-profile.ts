// @summary Domain helpers for WorldProfileData collision channel/profile structures.

import { isRecord } from "../ovdrjm-utils";
import {
  DEFAULT_CHANNEL_IDS,
  DEFAULT_CHANNEL_NAMES,
  DEFAULT_OBJECT_TYPE_NAMES,
  DEFAULT_PROFILE_DEFINITIONS,
  DEFAULT_PROFILE_NAMES,
  type DefaultProfileDefinition,
  type WorldProfileData,
} from "./defaults";
import { CollisionToolError } from "./results";
import type { CustomResponse } from "./schemas";

export type { WorldProfileData };

export function isCustomChannelId(value: string): boolean {
  const match = /^ECC_GameTraceChannel(\d+)$/.exec(value);
  if (!match) return false;
  const channelNumber = Number(match[1]);
  return Number.isInteger(channelNumber) && channelNumber >= 1 && channelNumber <= 18;
}

export function getWorldProfileData(document: Record<string, unknown>): WorldProfileData {
  const data = document.WorldProfileData;
  if (!isRecord(data) || Array.isArray(data)) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", "WorldProfileData is missing or invalid.");
  }
  return data;
}

export function getRecordArray(data: WorldProfileData, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && !Array.isArray(item))) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `WorldProfileData.${key} must be an array.`);
  }
  return value as Record<string, unknown>[];
}

export function ensureRecordArray(data: WorldProfileData, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (value === undefined) {
    const created: Record<string, unknown>[] = [];
    data[key] = created;
    return created;
  }
  return getRecordArray(data, key);
}

export function getEditProfiles(data: WorldProfileData): Record<string, unknown> {
  const value = data.EditProfiles;
  if (value === undefined) return {};
  if (!isRecord(value) || Array.isArray(value)) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", "WorldProfileData.EditProfiles must be an object.");
  }
  return value;
}

export function ensureEditProfiles(data: WorldProfileData): Record<string, unknown> {
  const value = data.EditProfiles;
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    data.EditProfiles = created;
    return created;
  }
  return getEditProfiles(data);
}

export function getCustomResponses(container: Record<string, unknown>, path: string): Record<string, unknown>[] {
  const value = container.customResponses;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && !Array.isArray(item))) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `${path}.customResponses must be an array.`);
  }
  return value as Record<string, unknown>[];
}

export function channelDisplayName(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  if (typeof entry.channel === "string" && entry.channel.startsWith("ECC_")) return entry.channel.slice(4);
  return undefined;
}

export function isCustomChannelEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.channel === "string" && isCustomChannelId(entry.channel);
}

export function channelNameSet(data: WorldProfileData): Set<string> {
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

export function hasChannelName(data: WorldProfileData, name: string, excludeChannel?: string): boolean {
  if (DEFAULT_CHANNEL_NAMES.has(name)) return true;
  return getRecordArray(data, "DefaultChannelResponses").some((entry) => {
    if (excludeChannel !== undefined && entry.channel === excludeChannel) return false;
    return channelDisplayName(entry) === name;
  });
}

export function findChannelEntry(
  entries: Record<string, unknown>[],
  channel: string,
): { entry: Record<string, unknown>; index: number } | undefined {
  const index = entries.findIndex((entry) => entry.channel === channel);
  if (index === -1) return undefined;
  return { entry: entries[index], index };
}

export function isKnownProtectedChannelIdentifier(value: string): boolean {
  return (
    DEFAULT_CHANNEL_NAMES.has(value) ||
    DEFAULT_CHANNEL_IDS.has(value) ||
    (value.startsWith("ECC_") && !isCustomChannelId(value))
  );
}

export function validateCustomResponses(responses: CustomResponse[], data: WorldProfileData): void {
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

export function validateObjectTypeName(objectTypeName: string, data: WorldProfileData): void {
  if (!objectTypeNameSet(data).has(objectTypeName)) {
    throw new CollisionToolError(
      "INVALID_CHANNEL",
      `${objectTypeName} is not a valid object type channel. Use a default object type or a custom non-trace channel.`,
    );
  }
}

export function findCustomProfile(
  profiles: Record<string, unknown>[],
  name: string,
): { profile: Record<string, unknown>; index: number } | undefined {
  const index = profiles.findIndex((profile) => profile.name === name);
  if (index === -1) return undefined;
  return { profile: profiles[index], index };
}

export function hasProfileName(data: WorldProfileData, name: string, excludeName?: string): boolean {
  if (DEFAULT_PROFILE_NAMES.has(name) && name !== excludeName) return true;
  return getRecordArray(data, "Profiles").some((profile) => profile.name === name && profile.name !== excludeName);
}

export function isDefaultProfileName(name: string): boolean {
  return DEFAULT_PROFILE_NAMES.has(name);
}

export function syncCustomResponseChannelNames(
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

export function syncProfileObjectTypeNames(
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

export function profilesUsingObjectType(data: WorldProfileData, objectTypeName: string): string[] {
  return getRecordArray(data, "Profiles")
    .filter((profile) => profile.objectTypeName === objectTypeName)
    .map((profile) => (typeof profile.name === "string" ? profile.name : "<unnamed>"));
}

export function removeCustomResponseChannel(
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

export function buildProfilesPayload(data: WorldProfileData): {
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
