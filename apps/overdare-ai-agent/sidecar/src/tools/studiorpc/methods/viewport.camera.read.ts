// @summary Declares the Studio RPC method for reading the camera that is currently on screen.
import { z } from "zod";
import { withCameraAxes } from "../camera-response";

export const method = "viewport.camera.read";

export const description =
  "Read the camera that is currently drawing the screen — where it sits, which way it faces, how much " +
  "of the world it covers, and what is under the middle of the screen. Use it to answer what the user " +
  "is looking at, to place something in front of the camera, or to convert between screen size and world " +
  "size; it needs no screenshot. " +
  'During a play test this returns the player camera (source "pieClient"), otherwise the editor viewport ' +
  'camera (source "editorViewport") — the same camera studiorpc_game_screenshot captures. ' +
  "CFrame matches studiorpc_instance_read and studiorpc_instance_upsert: Position in world units (1 unit = " +
  "1 cm) and Orientation as XYZ Euler angles in degrees — degrees, not radians — so a value read here can be " +
  "written straight back into a placement. Orientation.Y is the heading and Orientation.X the pitch: a yaw " +
  "of 0 looks down -Z, +90 looks down -X, and a positive pitch looks up. That is the convention " +
  "studiorpc_game_screenshot's locate is measured against, and the frame studiorpc_game_input_inject's " +
  "relative look turns within. " +
  "centerHit.position uses those same coordinates, so it can be " +
  "handed to studiorpc_instance_upsert or to studiorpc_game_screenshot's lookAt as-is. " +
  'Note that fieldOfView alone does not answer "how zoomed in are we": a perspective viewport keeps its ' +
  "field of view fixed and zooms by moving the camera, so focusDistance (the distance to whatever is under " +
  "the screen center) is the real zoom indicator, and visibleExtentAtFocus is how wide and tall the screen " +
  "is in world units at that distance. orthoWidth is filled in only for an orthographic viewport, where it " +
  "is the true magnification. centerHit, focusDistance and visibleExtentAtFocus are null when the center " +
  "of the screen hits nothing. " +
  "camera.axes gives the view's own directions as world unit vectors, which is what turns an instruction " +
  "phrased against the screen into an edit: groundRight and groundForward are right and forward flattened " +
  "onto the ground, so moving a part rightwards on screen is position + groundRight * distance. Use them " +
  "rather than re-deriving a heading from Orientation — the sign of right is easy to invert and a symmetric " +
  "scene gives back no sign that it was.";

export const params = z.object({}).strict();

export function postProcess(result: unknown): unknown {
  return withCameraAxes(result);
}
