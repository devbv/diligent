// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { z } from "zod";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport and save it to a file. " +
  'Two valid shapes: (1) { captureType: "Custom", size: { width, height } } for explicit dimensions, ' +
  'or (2) { captureType: "Viewport" | "Thumbnail" | "HubScreenshot" } with NO size field. ' +
  'captureType defaults to "Viewport" when omitted.';

const sizeSchema = z.object({
  width: z.number().int().positive().describe("Image width in pixels."),
  height: z.number().int().positive().describe("Image height in pixels."),
});

const customParams = z
  .object({
    captureType: z.literal("Custom").describe("Custom capture — requires an explicit `size` (width/height in pixels)."),
    size: sizeSchema.describe('REQUIRED for "Custom" capture. Image width and height in pixels.'),
  })
  .strict();

const presetParams = z
  .object({
    captureType: z
      .enum(["Viewport", "Thumbnail", "HubScreenshot"])
      .describe(
        "Preset capture mode with system-defined dimensions. " +
          'DO NOT include a "size" field for these modes — the call will be rejected.',
      ),
  })
  .strict();

export const params = z.preprocess(
  (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !("captureType" in value)) {
      return { ...(value as Record<string, unknown>), captureType: "Viewport" };
    }
    return value;
  },
  z.discriminatedUnion("captureType", [customParams, presetParams]),
);
