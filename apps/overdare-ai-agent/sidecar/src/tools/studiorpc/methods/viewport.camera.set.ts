// @summary Declares the Studio RPC method for aiming the editor viewport camera.
import { z } from "zod";
import { withCameraAxes } from "../camera-response";

export const method = "viewport.camera.set";

export const description =
  "Aim the editor viewport camera: put it at `position`, looking at `lookAt`. This moves the view " +
  'the user is looking at, so use it when they ask to see something — "show me the spawn", "look ' +
  'at it from behind" — or when you need a known vantage before reading the scene. ' +
  "Both points are world coordinates (1 unit = 1 cm), the same frame studiorpc_viewport_camera_read " +
  "reports and studiorpc_instance_read uses, so a position read from either goes straight in. The " +
  "horizon stays level: pitch and yaw come from the two points and roll is always zero. " +
  "The reply is a read-back of the camera as it actually ended up, not an echo of the request — " +
  "compare it when the aim matters. " +
  "Rejected while a play test runs: the player camera draws the screen then, and the editor " +
  "viewport this aims is not visible. Stop the play test first.";

const worldPoint = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const params = z
  .object({
    position: z.object(worldPoint.shape).describe("Where the camera goes, in world coordinates."),
    lookAt: z
      .object(worldPoint.shape)
      .describe("What it looks at. Must differ from position — two equal points have no direction between them."),
  })
  .strict();

// The read-back carries the same axes block the read tool adds. Two tools that return "the camera"
// and disagree about what a camera contains is a difference nobody can use.
export function postProcess(result: unknown): unknown {
  return withCameraAxes(result);
}
