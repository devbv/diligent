// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { z } from "zod";
import { type CameraBlock, projectWorldToScreen, unprojectScreenToPlane } from "../camera-projection";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport and save it to a file. " +
  "Take one whenever the question is what the screen looks like rather than what a value says — whether " +
  "text can be read, whether two things overlap, whether art is missing. Those have no property to query, " +
  "and every structured signal reads correct while the player sees a broken screen. " +
  "Colour is the exception, and it goes the other way: the capture runs through the scene's exposure and " +
  "post-processing, so the same button photographed green in one shot came out grey in another with no " +
  "code between them, and a play test reported the game greying out a control it never touched. Judge " +
  "layout, overlap and legibility from the picture; for what colour something actually is, read " +
  "studiorpc_game_ui_browse, which reports the live backgroundColor, textColor and contrast. " +
  'Currently only the "Viewport" mode is supported (defaults to "Viewport" when omitted). ' +
  "Other modes (Thumbnail / HubScreenshot / Custom with explicit size) are planned and not yet available. " +
  "GUI elements are included by default; pass includeGui: false to capture the scene only. " +
  "The image covers the same viewport rectangle that studiorpc_game_input_inject's " +
  "normalized pointer coordinates map onto, so a point read off the image as a fraction of its width and " +
  "height can be clicked directly. " +
  "The response reports the pixel size it actually captured, which is the size of the PNG on disk and the " +
  "aspect the camera saw. If whatever you read the file with reports different dimensions, it resampled the " +
  "picture for you — one tester compared its reader's 998x735 against a camera aspectRatio of 2.159 and " +
  "concluded the tool was distorting the shot. Judge proportion from the reported size, not from the " +
  "picture as your reader hands it over; normalized coordinates are unaffected either way. " +
  "The response also reports the camera the shot was taken from " +
  "(same block studiorpc_viewport_camera_read returns), and whether that camera is the editor viewport " +
  "or the running play test — enough to turn a point on the image back into a world ray, or to compare " +
  "the framing of a before and after shot. " +
  "Pass locate with world positions to have that conversion done for you: each one comes back as a pixel " +
  "and as a normalized point that studiorpc_game_input_inject accepts directly, plus onScreen telling you " +
  "whether it is in frame at all. That is how you check a thing you placed is where you meant it to be, or " +
  "aim a click at an object whose coordinates you know. Note that onScreen means inside the frustum, not " +
  "unoccluded — a part behind a wall still reports onScreen. " +
  "Pass pixelToGround with image pixels for the reverse: the world point where that pixel's view ray meets " +
  "a horizontal plane, for reading a position off a shot.";

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
    locate: z
      .array(worldPoint.extend({ label: z.string().optional().describe("Name echoed back on the result.") }))
      .max(32)
      .optional()
      .describe(
        "World positions to project onto the captured image. Each is returned with its pixel, its " +
          "normalized point for studiorpc_game_input_inject, and whether it is in frame.",
      ),
    pixelToGround: z
      .array(
        z.object({
          x: z.number().describe("Pixel column in the captured image, 0 at the left edge."),
          y: z.number().describe("Pixel row in the captured image, 0 at the top edge."),
          planeY: z.number().optional().describe("Height of the horizontal plane to hit. Defaults to 0."),
          label: z.string().optional().describe("Name echoed back on the result."),
        }),
      )
      .max(32)
      .optional()
      .describe("Image pixels to convert into world positions on a horizontal plane."),
  })
  .strict();

// Default at the RPC boundary (not via zod .default) so every call path —
// agent runtime and MCP server — sends an explicit includeGui to Studio.
/** locate and pixelToGround are computed here from the returned camera; Studio does not know them. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { locate: _l, pixelToGround: _p, ...rest } = args;
  return { ...rest, includeGui: rest.includeGui ?? true };
}

type Point = { x: number; y: number; z: number; label?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readVec3(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { X, Y, Z } = value;
  if (typeof X !== "number" || typeof Y !== "number" || typeof Z !== "number") return undefined;
  return { x: X, y: Y, z: Z };
}

function readCamera(result: unknown): { camera: CameraBlock; image: { width: number; height: number } } | undefined {
  if (!isRecord(result)) return undefined;
  const camera = isRecord(result.camera) ? result.camera : undefined;
  const image = isRecord(result.image) ? result.image : undefined;
  const cframe = camera && isRecord(camera.CFrame) ? camera.CFrame : undefined;
  const position = readVec3(cframe?.Position);
  const orientation = readVec3(cframe?.Orientation);
  if (!camera || !position || !orientation) return undefined;
  if (typeof camera.fieldOfView !== "number" || typeof camera.aspectRatio !== "number") return undefined;
  if (typeof image?.width !== "number" || typeof image?.height !== "number") return undefined;
  return {
    camera: { position, orientation, fieldOfView: camera.fieldOfView, aspectRatio: camera.aspectRatio },
    image: { width: image.width, height: image.height },
  };
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Studio's captured size and its reported aspectRatio agree in every capture measured,
 * so this fires only if that ever stops being true. Run 44's report of a stretched
 * image was its own file reader resampling the PNG, not Studio — but a genuine
 * disagreement here would silently invalidate every proportion read off the picture,
 * and the projection math below trusts aspectRatio.
 */
function aspectNote(read: { camera: CameraBlock; image: { width: number; height: number } }): string | undefined {
  const imageAspect = read.image.width / read.image.height;
  const stretch = imageAspect / read.camera.aspectRatio;
  if (stretch > 0.98 && stretch < 1.02) return undefined;
  return (
    `The image is ${read.image.width}x${read.image.height}, an aspect of ${round(imageAspect, 3)}, but the ` +
    `camera saw ${round(read.camera.aspectRatio, 3)}. The picture is squeezed horizontally to ` +
    `${round(stretch, 3)} of the view's proportions, so judge shapes and relative sizes with that in mind. ` +
    `Normalized coordinates are unaffected: a fraction of the image's width is still the same fraction of ` +
    `the viewport, which is why locate and pointer positions stay correct.`
  );
}

export function postProcess(result: unknown, args: Record<string, unknown>): unknown {
  const locate = Array.isArray(args.locate) ? (args.locate as Point[]) : undefined;
  const pixelToGround = Array.isArray(args.pixelToGround)
    ? (args.pixelToGround as { x: number; y: number; planeY?: number; label?: string }[])
    : undefined;
  const read = readCamera(result);
  if (!locate?.length && !pixelToGround?.length) {
    // Worth saying on every shot, not only the ones doing geometry — a distorted
    // picture misleads the eye whether or not anything was projected onto it.
    const note = read ? aspectNote(read) : undefined;
    return note && isRecord(result) ? { ...result, imageAspectNote: note } : result;
  }
  // An orthographic capture or a camera block the shot did not report leaves the request unanswered
  // rather than answered with perspective math that does not apply.
  if (!read || (isRecord(result) && isRecord(result.camera) && result.camera.projection !== "perspective")) {
    return { ...(isRecord(result) ? result : { result }), locateError: "camera block is missing or not perspective" };
  }
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  const note = aspectNote(read);
  if (note) out.imageAspectNote = note;
  if (locate?.length) {
    out.located = locate.map((point) => {
      const p = projectWorldToScreen(read.camera, read.image, point);
      return {
        ...(point.label === undefined ? {} : { label: point.label }),
        world: { x: point.x, y: point.y, z: point.z },
        pixel: { x: round(p.pixel.x, 1), y: round(p.pixel.y, 1) },
        normalized: { x: round(p.normalized.x, 4), y: round(p.normalized.y, 4) },
        onScreen: p.onScreen,
        behindCamera: p.behindCamera,
        distance: round(p.depth, 1),
      };
    });
  }
  if (pixelToGround?.length) {
    out.groundPoints = pixelToGround.map((entry) => {
      const hit = unprojectScreenToPlane(read.camera, read.image, entry, entry.planeY ?? 0);
      return {
        ...(entry.label === undefined ? {} : { label: entry.label }),
        pixel: { x: entry.x, y: entry.y },
        planeY: entry.planeY ?? 0,
        world: hit ? { x: round(hit.x), y: round(hit.y), z: round(hit.z) } : null,
        ...(hit ? {} : { note: "view ray never meets that plane in front of the camera" }),
      };
    });
  }
  return out;
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
