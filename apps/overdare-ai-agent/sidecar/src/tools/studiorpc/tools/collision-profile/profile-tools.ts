// @summary Collision profile CRUD tool implementations.

import type { Tool, ToolContext, ToolResult } from "../../types";
import type { WriteLock } from "../../write-lock";
import { readAndWriteOvdrjm, readOvdrjmDocument } from "../ovdrjm-utils";
import type { ApplyLevelChanges } from ".";
import { buildCollisionProfilesRender } from "./render";
import { approveWrite, CollisionToolError, errorResult, okResult } from "./results";
import {
  type CreateProfileInput,
  createProfileParams,
  deleteProfileParams,
  type EditProfileInput,
  editProfileParams,
  emptyParams,
} from "./schemas";
import {
  buildProfilesPayload,
  ensureEditProfile,
  ensureRecordArray,
  findCustomProfile,
  getWorldProfileData,
  hasProfileName,
  isDefaultProfileName,
  validateCustomResponses,
  validateObjectTypeName,
  type WorldProfileData,
} from "./world-profile";

function getCollisionProfiles(cwd: string): ToolResult {
  try {
    const { ovdrjmPath, document } = readOvdrjmDocument(cwd);
    const data = getWorldProfileData(document);
    const payload = buildProfilesPayload(data);
    return okResult(payload, { toolName: "get_collision_profiles", ovdrjmPath }, buildCollisionProfilesRender(payload));
  } catch (error) {
    return errorResult(error, "get_collision_profiles");
  }
}

async function createCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        { profile: fileResult.created, ovdrjmPath: fileResult.ovdrjmPath, levelApplyResult },
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

async function editCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
): Promise<ToolResult> {
  const toolName = "edit_collision_profile";
  try {
    const parsed = editProfileParams.parse(args);
    const rejected = await approveWrite(ctx, toolName, "Update collision profile in .ovdrjm WorldProfileData", parsed);
    if (rejected) return rejected;

    const release = await writeLock.acquire();
    try {
      const fileResult = readAndWriteOvdrjm(cwd, (document) => {
        const data = getWorldProfileData(document);
        if (parsed.customResponses !== undefined) validateCustomResponses(parsed.customResponses, data);

        if (isDefaultProfileName(parsed.name)) {
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        {
          profile: fileResult.updated,
          storedIn: fileResult.storedIn,
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

function updateDefaultProfile(
  parsed: EditProfileInput,
  data: WorldProfileData,
): { updated: Record<string, unknown>; storedIn: "EditProfiles" } {
  if (
    parsed.collisionEnabled !== undefined ||
    parsed.objectTypeName !== undefined ||
    parsed.helpMessage !== undefined
  ) {
    throw new CollisionToolError(
      "PROTECTED_PROFILE",
      "Default profiles only allow customResponses updates through EditProfiles. Retry with only name and customResponses.",
    );
  }
  if (parsed.customResponses === undefined) {
    throw new CollisionToolError("NO_UPDATES", "Default profile update requires customResponses.");
  }

  const editProfile = ensureEditProfile(data, parsed.name);
  editProfile.customResponses = parsed.customResponses;
  return { updated: editProfile, storedIn: "EditProfiles" };
}

async function deleteCollisionProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
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
        if (isDefaultProfileName(parsed.name)) {
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
      const levelApplyResult = await applyLevelChanges();
      return okResult(
        { profile: fileResult.deleted, ovdrjmPath: fileResult.ovdrjmPath, levelApplyResult },
        { toolName, ovdrjmPath: fileResult.ovdrjmPath },
      );
    } finally {
      release();
    }
  } catch (error) {
    return errorResult(error, toolName);
  }
}

export function createCollisionProfileCrudTools(
  cwd: string,
  writeLock: WriteLock,
  applyLevelChanges: ApplyLevelChanges,
): Tool[] {
  return [
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
        return createCollisionProfile(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
    {
      name: "edit_collision_profile",
      description:
        "Update a custom collision profile, or update customResponses for a default profile through EditProfiles.",
      parameters: editProfileParams,
      async execute(args, ctx) {
        return editCollisionProfile(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
    {
      name: "delete_collision_profile",
      description: "Delete a custom collision profile from WorldProfileData.Profiles.",
      parameters: deleteProfileParams,
      async execute(args, ctx) {
        return deleteCollisionProfile(args, ctx, cwd, writeLock, applyLevelChanges);
      },
    },
  ];
}
