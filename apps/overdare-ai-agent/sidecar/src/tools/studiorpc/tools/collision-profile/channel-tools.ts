// @summary Collision channel CRUD tool implementations.

import type { Tool, ToolContext, ToolResult } from "../../types";
import type { WriteLock } from "../../write-lock";
import { readAndWriteOvdrjm, readOvdrjmDocument } from "../ovdrjm-utils";
import type { ApplyLevelChanges } from ".";
import { buildCollisionChannelsRender } from "./render";
import { approveWrite, CollisionToolError, errorResult, okResult } from "./results";
import {
  addChannelParams,
  type CollisionChannelInput,
  deleteChannelParams,
  emptyParams,
  updateChannelParams,
} from "./schemas";
import {
  buildChannelsPayload,
  channelDisplayName,
  ensureRecordArray,
  findChannelEntry,
  getWorldProfileData,
  hasChannelName,
  isCustomChannelEntry,
  isCustomChannelId,
  isKnownProtectedChannelIdentifier,
  profilesUsingObjectType,
  removeCustomResponseChannel,
  syncCustomResponseChannelNames,
  syncProfileObjectTypeNames,
  type WorldProfileData,
} from "./world-profile";

function getCollisionChannels(cwd: string): ToolResult {
  try {
    const { ovdrjmPath, document } = readOvdrjmDocument(cwd);
    const data = getWorldProfileData(document);
    const payload = buildChannelsPayload(data);
    return okResult(payload, { toolName: "get_collision_channels", ovdrjmPath }, buildCollisionChannelsRender(payload));
  } catch (error) {
    return errorResult(error, "get_collision_channels");
  }
}

async function addCollisionChannel(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        { channel: fileResult.added, ovdrjmPath: fileResult.ovdrjmPath, levelApplyResult },
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
  applyLevelChanges: ApplyLevelChanges,
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        {
          channel: fileResult.updated,
          sync: fileResult.sync,
          ovdrjmPath: fileResult.ovdrjmPath,
          levelApplyResult,
        },
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
  applyLevelChanges: ApplyLevelChanges,
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        {
          channel: fileResult.deleted,
          cleanup: fileResult.cleanup,
          ovdrjmPath: fileResult.ovdrjmPath,
          levelApplyResult,
        },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

export function createCollisionChannelTools(
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
): Tool[] {
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
        return addCollisionChannel(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
    {
      name: "update_collision_channel",
      description:
        "Update a custom collision channel and synchronize renamed channel references in profile customResponses.",
      parameters: updateChannelParams,
      async execute(args, ctx) {
        return updateCollisionChannel(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
    {
      name: "delete_collision_channel",
      description:
        "Delete a custom collision channel and remove matching channel responses from all collision profiles.",
      parameters: deleteChannelParams,
      async execute(args, ctx) {
        return deleteCollisionChannel(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
  ];
}
