// @summary Zod schemas for collision channel and profile tool inputs.

import { z } from "zod";

export const collisionResponseSchema = z.enum(["ECR_Block", "ECR_Overlap", "ECR_Ignore"]);
export const collisionEnabledSchema = z.enum(["NoCollision", "QueryOnly", "PhysicsOnly", "QueryAndPhysics"]);

const nameSchema = z.string().min(1).max(50);

export const customResponseSchema = z
  .object({
    channel: z.string().min(1).describe("Collision channel name, such as WorldStatic or a custom channel name."),
    response: collisionResponseSchema,
  })
  .strict();

export const emptyParams = z.object({}).strict();

export const addChannelParams = z
  .object({
    channel: z.string().min(1).describe("Unused ECC_GameTraceChannel1 through ECC_GameTraceChannel18 value."),
    name: nameSchema.describe("Unique collision channel name."),
    defaultResponse: collisionResponseSchema,
    bTraceType: z.boolean(),
    bStaticObject: z.boolean(),
  })
  .strict();

export const updateChannelParams = z
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

export const deleteChannelParams = z
  .object({
    channel: z.string().min(1).describe("Collision channel identifier to delete."),
  })
  .strict();

export const createProfileParams = z
  .object({
    name: nameSchema.describe("Unique custom collision profile name."),
    collisionEnabled: collisionEnabledSchema.default("QueryAndPhysics"),
    objectTypeName: z.string().min(1).describe("Object type channel name for this profile."),
    customResponses: z.array(customResponseSchema).optional(),
    helpMessage: z.string().optional(),
    bCanModify: z.boolean().optional().describe("Ignored. Custom profiles are always written with bCanModify: true."),
  })
  .strict();

const editDefaultProfileParams = z
  .object({
    profileType: z
      .literal("default")
      .describe("Use for default engine profiles. Only customResponses can be overridden."),
    name: nameSchema.describe("Default collision profile name to override through EditProfiles."),
    customResponses: z
      .array(customResponseSchema)
      .describe("Complete customResponses override for the default profile. Stored in EditProfiles."),
  })
  .strict();

const editCustomProfileParams = z
  .object({
    profileType: z.literal("custom").describe("Use for creator-defined profiles stored in WorldProfileData.Profiles."),
    name: nameSchema.describe("Collision profile name to update."),
    collisionEnabled: collisionEnabledSchema.optional(),
    objectTypeName: z.string().min(1).optional().describe("Object type channel name for this custom profile."),
    customResponses: z.array(customResponseSchema).optional(),
    helpMessage: z.string().nullable().optional(),
  })
  .strict();

export const editProfileParams = z
  .discriminatedUnion("profileType", [editDefaultProfileParams, editCustomProfileParams])
  .describe(
    "Use profileType=default to override only customResponses in EditProfiles. Use profileType=custom to edit creator-defined profiles.",
  );

export const deleteProfileParams = z
  .object({
    name: nameSchema.describe("Custom collision profile name to delete."),
  })
  .strict();

export type CustomResponse = z.infer<typeof customResponseSchema>;
export type CollisionChannelInput = z.infer<typeof addChannelParams>;
export type CreateProfileInput = z.infer<typeof createProfileParams>;
export type EditProfileInput = z.infer<typeof editProfileParams>;
