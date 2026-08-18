// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { readFile } from "node:fs/promises";
import type { ImageBlock } from "@diligent/protocol";
import { z } from "zod";
import { type CameraBlock, projectWorldToScreen, unprojectScreenToPlane } from "../camera-projection";
import {
  type CallRpc,
  isRecord,
  listRunningInstanceNames,
  locateInstanceByName,
  readVec3,
  withCameraAxes,
} from "../camera-response";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport. The picture comes back with the answer, so there " +
  "is nothing to open afterwards; it is also saved to a file, whose path the reply reports, for when you " +
  "want to hand it to something else. " +
  "Take one whenever the question is what the screen looks like rather than what a value says — whether " +
  "text can be read, whether two things overlap, whether art is missing. Every structured signal can read " +
  "correct while the player sees a broken screen. " +
  "Overlap is now half-answerable without a picture: studiorpc_game_ui_browse reports occludedBy and " +
  "occludedFraction for text with something painted over it. That tells you a label is covered and by how " +
  "much of its area; it cannot tell you which words are gone. When the missing characters are the finding — " +
  "a countdown, a total, the tail of a sentence — the picture is still the only answer. " +
  "Colour is the exception, and it goes the other way: the capture runs through the scene's exposure and " +
  "post-processing, so the same button photographed green in one shot came out grey in another with no " +
  "code between them, and a play test reported the game greying out a control it never touched. Judge " +
  "layout, overlap and legibility from the picture; for what colour something actually is, read " +
  "studiorpc_game_ui_browse, which reports the live backgroundColor, textColor and contrast. " +
  "The on-screen UI is in the shot unless you pass includeGui: false, which leaves the world render on its " +
  "own. The image covers the same viewport rectangle that studiorpc_game_input_inject's " +
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
  "Pass locate to have that conversion done for you. Each entry is either a world position or a name — a " +
  "dotted path as readily as a bare one, and a path is the only form that identifies one instance in a " +
  "world that reuses names, so a bare name that matched several says so. Names are looked up in the running " +
  "game, or in the saved level when no play test is up. Either way the entry comes back as a pixel and as a " +
  "normalized point that studiorpc_game_input_inject accepts directly, plus onScreen telling you whether it " +
  "is in frame at all. That is how you check a thing you placed is where you meant it to be, or aim a click " +
  "at an object whose coordinates you know. Note that onScreen means inside the frustum, not unoccluded — a " +
  "part behind a wall still reports onScreen. " +
  "Pass pixelToGround with image pixels for the reverse: the world point where that pixel's view ray meets " +
  "a horizontal plane, for reading a position off a shot. " +
  "The camera block also reports axes — the view's forward/right/up as world vectors, plus groundRight and " +
  "groundForward flattened onto the horizontal plane. Those are what convert an instruction given against " +
  "the screen into an edit: position + groundRight * distance moves a part rightwards from where the user " +
  "is looking. Project it again afterwards and check the pixel moved the way you intended, because an " +
  "inverted right vector moves everything the wrong way and looks perfectly correct in the numbers.";

const worldPoint = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const params = z
  .object({
    includeGui: z
      .boolean()
      .optional()
      .describe(
        "Whether the on-screen UI is in the capture. Defaults to true, which is what 255 of 290 measured " +
          "captures asked for; pass false for the world render on its own.",
      ),
    camera: z
      .object({ position: worldPoint, lookAt: worldPoint })
      .optional()
      .describe(
        "Where to put the camera for this one shot, and what to aim it at. These were two parameters that " +
          "had to be given together, which is a pair an agent can get half right; one object cannot be. " +
          "Same world coordinates as studiorpc_instance_read and studiorpc_viewport_camera_read (1 unit = " +
          "1 cm), so a position read from either goes straight in. The editor viewport returns to where the " +
          "user left it once the capture finishes. Rejected while a play test is running, because then the " +
          "player camera is what fills the screen.",
      ),
    locate: z
      .array(
        z.union([
          z.string().min(1),
          worldPoint.extend({ label: z.string().optional().describe("Name echoed back on the result.") }),
        ]),
      )
      .max(32)
      .optional()
      .describe(
        "What to project onto the captured image: either a world position, or the name or dotted path of an " +
          "instance whose coordinates you do not already have. Both kinds may be mixed in one list, and each " +
          "comes back in `located` with its pixel, its normalized point for studiorpc_game_input_inject, and " +
          'whether it is in frame. This is the call that answers "which of these is the one at the top ' +
          'left": ask for the names and sort the results by normalized y then x, instead of listing ' +
          "instances, copying coordinates, and projecting them in a second call.",
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
  const { locate: _l, pixelToGround: _p, camera, ...rest } = args;
  // Studio still takes the placement as two fields. Declaring it as one is what stops half of
  // it arriving: `cameraPosition` without `lookAt` was a rejected call, and the caller had no
  // way to see that the two belonged together except by reading both descriptions.
  if (isRecord(camera)) {
    Object.assign(rest, { cameraPosition: camera.position, lookAt: camera.lookAt });
  }
  // Studio's own default is a world-only render, which 255 of 290 measured captures then had to
  // ask out of. The default is stated here rather than there because Studio has other callers.
  return { includeGui: true, ...rest };
}

/**
 * Hand the picture back with the answer.
 *
 * Studio writes a PNG and reports where. Reporting only where makes the caller fetch it, and
 * measured across 294 captures in the run archive, 274 were followed within three calls by reading
 * that file — so the second call is not an option a caller weighs, it is what taking a screenshot
 * costs. The catalog downscales whatever comes out of here, so the file is read as it was written.
 *
 * A picture that cannot be read is not an error: the reply still carries the path, the camera and
 * the projections, and every one of those answers a question on its own.
 */
export async function attachImages(result: unknown): Promise<ImageBlock[] | undefined> {
  if (!isRecord(result) || typeof result.path !== "string") return undefined;
  try {
    const bytes = await readFile(result.path);
    return [{ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }];
  } catch {
    return undefined;
  }
}

type Point = { x: number; y: number; z: number; label?: string };

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

export async function postProcess(result: unknown, args: Record<string, unknown>, callRpc: CallRpc): Promise<unknown> {
  // One parameter, two kinds of entry: a string is a name to look up, anything else is already a
  // position. They were two parameters until a census found no call had ever used both.
  const requested = Array.isArray(args.locate) ? (args.locate as (string | Point)[]) : [];
  const locate = requested.filter((entry): entry is Point => typeof entry !== "string");
  const locateNames = requested.filter((entry): entry is string => typeof entry === "string");
  const pixelToGround = Array.isArray(args.pixelToGround)
    ? (args.pixelToGround as { x: number; y: number; planeY?: number; label?: string }[])
    : undefined;
  const read = readCamera(result);
  if (!locate?.length && !locateNames?.length && !pixelToGround?.length) {
    // Worth saying on every shot, not only the ones doing geometry — a distorted
    // picture misleads the eye whether or not anything was projected onto it.
    const note = read ? aspectNote(read) : undefined;
    return withCameraAxes(note && isRecord(result) ? { ...result, imageAspectNote: note } : result);
  }
  // An orthographic capture or a camera block the shot did not report leaves the request unanswered
  // rather than answered with perspective math that does not apply.
  if (!read || (isRecord(result) && isRecord(result.camera) && result.camera.projection !== "perspective")) {
    return { ...(isRecord(result) ? result : { result }), locateError: "camera block is missing or not perspective" };
  }
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  const note = aspectNote(read);
  if (note) out.imageAspectNote = note;

  const named: Point[] = [];
  const absent: string[] = [];
  const failed: string[] = [];
  const ambiguous: string[] = [];
  let failureDetail = "";
  for (const name of locateNames ?? []) {
    const result = await locateInstanceByName(callRpc, name);
    if (result.found) {
      // Label it with what actually answered. Asking for "Pot2" and getting a pixel back is
      // only useful if the pixel is the Pot2 you meant, and in a world with sixteen of them it
      // need not be — run 71 was handed another tray's pair with nothing to notice it by.
      named.push({ ...result.position, label: result.path ?? name });
      if (result.matches !== undefined && result.matches > 1) {
        ambiguous.push(`${name}: ${result.matches} instances share that name; this one is ${result.path ?? "unknown"}`);
      }
    } else if (result.reason === "lookupFailed") {
      failed.push(name);
      failureDetail ||= result.detail;
    } else {
      absent.push(name);
    }
  }
  // One listing for the whole batch, and only when something was actually absent. Per name it
  // would be up to 32 extra round trips on the path whose entire point is to save calls.
  const nearby = absent.length > 0 ? await listRunningInstanceNames(callRpc) : [];
  // Saying which names went unanswered matters more than it looks: a shorter located array than
  // the list asked for reads as "the rest are off screen" if nothing says otherwise. And the two
  // ways a name can go unanswered need opposite responses — one is "you named the wrong thing",
  // the other is "ask again" — so they are never merged into one list again.
  if (absent.length > 0) {
    out.locateNotFound = absent;
    out.locateNote =
      "Those names are in neither the running game nor the saved level. A name a script invented at run " +
      "time exists only while the play test is up." +
      (nearby.length > 0 ? ` The running game lists: ${nearby.slice(0, 12).join(", ")}.` : "");
  }
  if (ambiguous.length > 0) {
    out.locateAmbiguous = ambiguous;
    out.locateAmbiguousNote =
      "A name is unique only among siblings, so these each matched more than one instance and the pixel " +
      "reported is for the one listed. Pass the dotted path instead — locate takes either — to say " +
      "which one you meant.";
  }
  if (failed.length > 0) {
    out.locateUnanswered = failed;
    out.locateUnansweredNote =
      "Looking these up failed, so nothing is known about them — this is not the same as their being " +
      `absent, and they may well be there. The first error was: ${failureDetail}. Retrying is reasonable ` +
      "here, unlike for locateNotFound.";
  }

  const points = [...(locate ?? []), ...named];
  if (points.length > 0) {
    out.located = points.map((point) => {
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
  return withCameraAxes(out);
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
