// @summary Declares the Studio RPC method for reading the play-test character's state.
import { z } from "zod";

export const method = "game.character.read";

export const description =
  "Read where the play-test character is, whether it is moving, and what it is standing on. " +
  "This is how you tell whether input did anything: send a key batch, read this, and compare — one call " +
  "answers it, so never poll a screenshot or the camera to work out whether the character moved. " +
  "speed and moving come from the character's own velocity, so a character that is stuck against a wall " +
  "reads as not moving even while you hold a key down, which is exactly the signal that tells you a " +
  "collision is blocking it. standingOn names the surface under its feet, or is null when nothing is there " +
  "— that is what falling looks like. It is a probe straight down, not a touch: standingOn.distance is the " +
  "gap to that surface, so a distance of 0 means the character is level with the part, and never means the " +
  "part's Touched event fired. Whether a trigger actually went off is something only the game's own state " +
  "can tell you. The probe reports whatever is below regardless of CanCollide, so a part the character walks " +
  "straight through still shows up here — standing on something and being held up by it are different " +
  "questions, and this answers the first. " +
  "CFrame is in the same world coordinates as studiorpc_instance_read and studiorpc_viewport_camera_read, " +
  "so a position from any of them can be handed straight to studiorpc_game_character_move_to.";

export const params = z.object({}).strict();
