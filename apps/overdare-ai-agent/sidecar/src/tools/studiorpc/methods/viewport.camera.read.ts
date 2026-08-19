// @summary Declares the Studio RPC method for reading the camera that is currently on screen.
import { z } from "zod";
import { withCameraAxes } from "../camera-response";

export const method = "viewport.camera.read";

export const description =
  "Read the camera that is currently drawing the screen — where it sits, which way it faces, and what is " +
  "under the middle of the screen. Use it to answer what the user is looking at, to place something in " +
  "front of the camera, or to turn screen-relative words — left, right, behind — into world coordinates; " +
  "it needs no screenshot. " +
  "During a play test this returns the player camera, otherwise the editor viewport camera — the same " +
  "camera studiorpc_game_screenshot captures, and the one studiorpc_viewport_camera_set aims. " +
  "CFrame matches studiorpc_instance_read and studiorpc_instance_upsert: Position in world units (1 unit = " +
  "1 cm) and Orientation as XYZ Euler angles in degrees — degrees, not radians — so a value read here can be " +
  "written straight back into a placement. Orientation.Y is the heading and Orientation.X the pitch: a yaw " +
  "of 0 looks down -Z, +90 looks down -X, and a positive pitch looks up. That is the convention " +
  "studiorpc_game_screenshot's locate is measured against, the frame studiorpc_game_input_inject's " +
  "relative look turns within, and the same number studiorpc_game_character_read reports as facing.yaw — " +
  "one heading in one frame, with no sign to flip between them. " +
  "centerHit is what the middle of the screen lands on — its position in those same coordinates (handed " +
  "to studiorpc_instance_upsert or a lookAt as-is) and its name; null when the center hits nothing. The " +
  "distance from Position to centerHit.position is how zoomed-in the view effectively is — a perspective " +
  "camera keeps fieldOfView fixed and zooms by moving. fieldOfView and aspectRatio are the projection's " +
  "two numbers, enough to compute where any world point sits on screen. fieldOfView is the HORIZONTAL " +
  "angle in degrees; the vertical one is narrower by aspectRatio — tan(vertical/2) = tan(fieldOfView/2) / " +
  "aspectRatio. So for a point at camera-space (right, up, depth): screenX = 0.5 + right / depth / " +
  "tan(fieldOfView/2) / 2, and screenY = 0.5 - up * aspectRatio / depth / tan(fieldOfView/2) / 2. Reading " +
  "the angle as vertical and dividing the other axis instead puts a point about a tenth of the screen off, " +
  "which is a wrong control clicked, not a rounding difference. " +
  "A `projection` field appears only when the viewport is orthographic, with orthoWidth as its magnification. " +
  "camera.axes gives the view's own directions as world unit vectors, which is what turns an instruction " +
  "phrased against the screen into an edit: groundRight and groundForward are right and forward flattened " +
  "onto the ground, so moving a part rightwards on screen is position + groundRight * distance. Use them " +
  "rather than re-deriving a heading from Orientation — the sign of right is easy to invert and a symmetric " +
  "scene gives back no sign that it was.";

export const params = z.object({}).strict();

export function postProcess(result: unknown): unknown {
  return withCameraAxes(result);
}
