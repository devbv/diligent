// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { z } from "zod";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport and save it to a file. " +
  'captureType defaults to "Viewport". When captureType is "Custom", `size` (width/height in pixels) is required.';

const sizeSchema = z.object({
  width: z.number().int().positive().describe("Image width in pixels (Custom only)"),
  height: z.number().int().positive().describe("Image height in pixels (Custom only)"),
});

export const params = z
  .object({
    captureType: z
      .enum(["Viewport", "Thumbnail", "HubScreenshot", "Custom"])
      .optional()
      .describe('Capture mode. Defaults to "Viewport".'),
    size: sizeSchema.optional().describe('Required only when captureType is "Custom".'),
  })
  .superRefine((value, ctx) => {
    if (value.captureType === "Custom" && !value.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["size"],
        message: 'size is required when captureType is "Custom".',
      });
    }
    if (value.captureType && value.captureType !== "Custom" && value.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["size"],
        message: `size is only allowed when captureType is "Custom" (got "${value.captureType}").`,
      });
    }
  });
