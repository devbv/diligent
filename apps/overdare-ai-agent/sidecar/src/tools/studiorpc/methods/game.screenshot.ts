// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { z } from "zod";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport and save it to a file. " +
  "Take one whenever the question is what the screen looks like rather than what a value says — whether " +
  "text can be read, whether two things overlap, whether art is missing. Those have no property to query, " +
  "and every structured signal reads correct while the player sees a broken screen. " +
  'Currently only the "Viewport" mode is supported (defaults to "Viewport" when omitted). ' +
  "Other modes (Thumbnail / HubScreenshot / Custom with explicit size) are planned and not yet available. " +
  "GUI elements are included by default; pass includeGui: false to capture the scene only. " +
  "The image covers the same viewport rectangle that studiorpc_game_input_inject's " +
  "normalized pointer coordinates map onto, so a point read off the image as a fraction of its width and " +
  "height can be clicked directly. " +
  "The response reports the pixel size it actually captured, the camera the shot was taken from " +
  "(same block studiorpc_viewport_camera_read returns), and whether that camera is the editor viewport " +
  "or the running play test — enough to turn a point on the image back into a world ray, or to compare " +
  "the framing of a before and after shot.";

const worldPoint = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const params = z
  .object({
    captureType: z
      .literal("Viewport")
      .optional()
      .describe('Capture mode. Currently only "Viewport" is supported. Defaults to "Viewport" when omitted.'),
    includeGui: z
      .boolean()
      .optional()
      .describe("Whether to include GUI elements in the capture. Defaults to true when omitted."),
    cameraPosition: worldPoint
      .optional()
      .describe(
        "Where to put the camera for this one shot. Must be given together with lookAt. Same world " +
          "coordinates as studiorpc_instance_read and studiorpc_viewport_camera_read (1 unit = 1 cm), so a " +
          "position read from either can be passed straight in. " +
          "The editor viewport returns to where the user left it once the capture finishes. " +
          "Rejected while a play test is running, because then the player camera is what fills the screen.",
      ),
    lookAt: worldPoint
      .optional()
      .describe(
        "World point the camera aims at, in the same coordinates as cameraPosition. Must be given together " +
          "with it.",
      ),
  })
  .strict();

// Default at the RPC boundary (not via zod .default) so every call path —
// agent runtime and MCP server — sends an explicit includeGui to Studio.
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, includeGui: args.includeGui ?? true };
}

// When additional capture modes are supported, restore the discriminated-union
// schema below. It rejects mismatched `size` usage at the schema layer (instead
// of via a post-hoc refine) so models like ChatGPT can't silently keep sending
// `size` with a preset capture mode.
//
// const sizeSchema = z.object({
//   width: z.number().int().positive().describe("Image width in pixels."),
//   height: z.number().int().positive().describe("Image height in pixels."),
// });
//
// const customParams = z
//   .object({
//     captureType: z.literal("Custom").describe("Custom capture — requires an explicit `size` (width/height in pixels)."),
//     size: sizeSchema.describe('REQUIRED for "Custom" capture. Image width and height in pixels.'),
//   })
//   .strict();
//
// const presetParams = z
//   .object({
//     captureType: z
//       .enum(["Viewport", "Thumbnail", "HubScreenshot"])
//       .describe(
//         "Preset capture mode with system-defined dimensions. " +
//           'DO NOT include a "size" field for these modes — the call will be rejected.',
//       ),
//   })
//   .strict();
//
// export const params = z.preprocess(
//   (value) => {
//     if (value && typeof value === "object" && !Array.isArray(value) && !("captureType" in value)) {
//       return { ...(value as Record<string, unknown>), captureType: "Viewport" };
//     }
//     return value;
//   },
//   z.discriminatedUnion("captureType", [customParams, presetParams]),
// );
