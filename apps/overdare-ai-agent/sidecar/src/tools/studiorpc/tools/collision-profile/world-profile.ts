// @summary Domain helpers for WorldProfileData collision channel/profile structures.

import { isRecord } from "../ovdrjm-utils";
import {
  DEFAULT_CHANNEL_IDS,
  DEFAULT_CHANNEL_NAMES,
  DEFAULT_CHANNELS,
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
  const data = findWorldProfileData(document);
  if (!data) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", "WorldProfileData is missing or invalid.");
  }
  return data;
}

function findWorldProfileData(document: Record<string, unknown>): WorldProfileData | undefined {
  const direct = document.WorldProfileData;
  if (isRecord(direct) && !Array.isArray(direct)) return direct;

  const root = document.Root;
  if (!isRecord(root) || Array.isArray(root)) return undefined;
  return findWorldProfileDataInNode(root);
}

function findWorldProfileDataInNode(node: Record<string, unknown>): WorldProfileData | undefined {
  const data = node.WorldProfileData;
  if (isRecord(data) && !Array.isArray(data)) return data;

  const children = node.LuaChildren;
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    if (!isRecord(child) || Array.isArray(child)) continue;
    const found = findWorldProfileDataInNode(child);
    if (found) return found;
  }
  return undefined;
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

type EditProfileEntry = {
  name: string;
  profile: Record<string, unknown>;
  path: string;
};

export function getEditProfileEntries(data: WorldProfileData): EditProfileEntry[] {
  const value = data.EditProfiles;
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (!isRecord(entry) || Array.isArray(entry)) {
        throw new CollisionToolError(
          "INVALID_WORLD_PROFILE_DATA",
          `WorldProfileData.EditProfiles[${index}] must be an object.`,
        );
      }
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw new CollisionToolError(
          "INVALID_WORLD_PROFILE_DATA",
          `WorldProfileData.EditProfiles[${index}].name is missing.`,
        );
      }
      return { name: entry.name, profile: entry, path: `EditProfiles.${entry.name}` };
    });
  }
  if (!isRecord(value)) {
    throw new CollisionToolError(
      "INVALID_WORLD_PROFILE_DATA",
      "WorldProfileData.EditProfiles must be an object or array.",
    );
  }
  return Object.entries(value).map(([name, editProfile]) => {
    if (!isRecord(editProfile) || Array.isArray(editProfile)) {
      throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `EditProfiles.${name} must be an object.`);
    }
    return { name, profile: editProfile, path: `EditProfiles.${name}` };
  });
}

export function ensureEditProfile(data: WorldProfileData, name: string): Record<string, unknown> {
  const value = data.EditProfiles;
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    data.EditProfiles = { [name]: created };
    return created;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (!isRecord(entry) || Array.isArray(entry)) {
        throw new CollisionToolError(
          "INVALID_WORLD_PROFILE_DATA",
          `WorldProfileData.EditProfiles[${index}] must be an object.`,
        );
      }
      if (entry.name === name) return entry;
    }
    const created: Record<string, unknown> = { name };
    value.push(created);
    return created;
  }
  if (!isRecord(value)) {
    throw new CollisionToolError(
      "INVALID_WORLD_PROFILE_DATA",
      "WorldProfileData.EditProfiles must be an object or array.",
    );
  }
  const current = value[name];
  if (current === undefined) {
    const created: Record<string, unknown> = {};
    value[name] = created;
    return created;
  }
  if (!isRecord(current) || Array.isArray(current)) {
    throw new CollisionToolError("INVALID_WORLD_PROFILE_DATA", `EditProfiles.${name} must be an object.`);
  }
  return current;
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

export function buildChannelsPayload(data: WorldProfileData): {
  defaultChannels: Record<string, unknown>[];
  customChannels: Record<string, unknown>[];
} {
  const channels = getRecordArray(data, "DefaultChannelResponses");
  const customChannels = channels.filter((entry) => isCustomChannelEntry(entry));
  const storedDefaultsByName = new Map<string, Record<string, unknown>>();
  const extraDefaultChannels: Record<string, unknown>[] = [];

  for (const entry of channels) {
    if (isCustomChannelEntry(entry)) continue;
    const name = channelDisplayName(entry);
    if (name && DEFAULT_CHANNEL_NAMES.has(name)) {
      storedDefaultsByName.set(name, entry);
    } else {
      extraDefaultChannels.push(entry);
    }
  }

  const defaultChannels = DEFAULT_CHANNELS.map((channel) => ({
    ...channel,
    ...storedDefaultsByName.get(channel.name),
  }));

  return { defaultChannels: [...defaultChannels, ...extraDefaultChannels], customChannels };
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

  for (const { profile: editProfile, path } of getEditProfileEntries(data)) {
    const responses = getCustomResponses(editProfile, path);
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

  for (const { profile: editProfile, path } of getEditProfileEntries(data)) {
    const responses = getCustomResponses(editProfile, path);
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
  const profiles = getRecordArray(data, "Profiles");
  const profilesByName = new Map(
    profiles.flatMap((profile) => (typeof profile.name === "string" ? [[profile.name, profile]] : [])),
  );
  const editProfilesByName = new Map(getEditProfileEntries(data).map((entry) => [entry.name, entry.profile]));
  const defaultProfiles = DEFAULT_PROFILE_DEFINITIONS.map((profile) => {
    const storedProfile = profilesByName.get(profile.name);
    const baseProfile = storedProfile ?? profile;
    const editProfile = editProfilesByName.get(profile.name);
    const customResponses =
      isRecord(editProfile) && !Array.isArray(editProfile)
        ? (getCustomResponses(editProfile, `EditProfiles.${profile.name}`) as CustomResponse[])
        : ((getCustomResponses(baseProfile, `Profiles.${profile.name}`) as CustomResponse[]) ??
          profile.customResponses);

    return {
      ...profile,
      ...baseProfile,
      customResponses,
      bCanModify: false as const,
    };
  });

  const customProfiles = profiles
    .filter((profile) => typeof profile.name !== "string" || !isDefaultProfileName(profile.name))
    .map((profile) => ({
      ...profile,
      bCanModify: profile.bCanModify === undefined ? true : profile.bCanModify,
    }));

  return { defaultProfiles, customProfiles };
}
