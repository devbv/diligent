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

/** Fields a default engine profile cannot carry — only its customResponses may be overridden. */
const CUSTOM_ONLY_PROFILE_FIELDS = ["collisionEnabled", "objectTypeName", "helpMessage"] as const;

// Kept as a single object schema rather than a discriminated union: a top-level union converts to
// `{ anyOf: [...] }`, which is not an object schema and is not uniformly supported across model
// providers. The profileType branches are enforced in `superRefine` instead.
export const editProfileParams = z
  .object({
    profileType: z
      .enum(["default", "custom"])
      .describe(
        "Use default for built-in engine profiles, where only customResponses can be overridden through EditProfiles. Use custom for creator-defined profiles stored in WorldProfileData.Profiles.",
      ),
    name: nameSchema.describe("Collision profile name to update."),
    customResponses: z
      .array(customResponseSchema)
      .optional()
      .describe("Complete customResponses override. Required when profileType=default."),
    collisionEnabled: collisionEnabledSchema.optional().describe("profileType=custom only."),
    objectTypeName: z
      .string()
      .min(1)
      .optional()
      .describe("Object type channel name for this custom profile. profileType=custom only."),
    helpMessage: z.string().nullable().optional().describe("profileType=custom only. Pass null to clear it."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.profileType !== "default") return;

    if (value.customResponses === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customResponses"],
        message: "customResponses is required when profileType=default.",
      });
    }
    for (const field of CUSTOM_ONLY_PROFILE_FIELDS) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} cannot be set when profileType=default; only customResponses can be overridden.`,
        });
      }
    }
  });

export const deleteProfileParams = z
  .object({
    name: nameSchema.describe("Custom collision profile name to delete."),
  })
  .strict();

export type CustomResponse = z.infer<typeof customResponseSchema>;
export type CollisionChannelInput = z.infer<typeof addChannelParams>;
export type CreateProfileInput = z.infer<typeof createProfileParams>;
export type EditProfileInput = z.infer<typeof editProfileParams>;
