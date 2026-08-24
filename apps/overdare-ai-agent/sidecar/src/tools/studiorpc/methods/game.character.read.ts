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
  "gap from the character's feet to that surface, so standing on something reads 0 and anything above 0 is " +
  "the height it is hovering or falling through. A distance of 0 never means the " +
  "part's Touched event fired. Whether a trigger actually went off is something only the game's own state " +
  "can tell you. The probe reports whatever is below regardless of CanCollide, so a part the character walks " +
  "straight through still shows up here — standing on something and being held up by it are different " +
  "questions, and this answers the first. " +
  "CFrame is in the same world coordinates as studiorpc_instance_read and studiorpc_viewport_camera_read, " +
  "so a position from any of them can be handed straight to studiorpc_game_character_move_to. " +
  "facing is where the view is pointing, in the same degrees studiorpc_game_input_inject's look event " +
  "reports and moves. Read it before sending W: key movement is camera-relative, so after any look the " +
  "same key walks a different direction in the world, and one run walked its character back down the route " +
  "it had just climbed. facing.yaw is the same number as studiorpc_viewport_camera_read's Orientation.Y " +
  "and as the yawDegrees a look event takes: 0 faces -Z, +90 faces -X, and positive turns left. Those " +
  "used to be two conventions, one the negation of the other, and the sign is a trap this loop has " +
  "already paid for once — there is nothing left to convert. " +
  "gameTimeSeconds is the world's own clock, which is the clock a timed round runs on. Its value on its " +
  "own means nothing; the difference between two reads is how much game time your calls and your reasoning " +
  "just cost, which is the only way to tell a round that expired from one that was never started. This is " +
  "the cheap way to ask: reading it off a countdown on screen costs a whole ui section. " +
  "When the next thing you want after this is the UI or some instances, ask studiorpc_game_observe for all " +
  "of it instead: separate calls are seconds of game time apart and describe different moments, and one " +
  "observe stamps the moment they all share.";

export const params = z
  .object({
    pieSessionId: z
      .string()
      .optional()
      .describe("Session to read from. Omit for the live session, and omit it whenever clientId is omitted."),
    clientId: z
      .string()
      .optional()
      .describe(
        "Which play-test client's character to read. Omit — as almost every call should — and it reads the " +
          "main play test, the one studiorpc_game_pie_status marks targeted: true. Pass one only in a session " +
          "started with more than one player, where input and move_to can drive the others by id and this is " +
          "the only read that can follow them there. Needs pieSessionId alongside it; without both, the main " +
          "client is read. A client that is not injectable is refused rather than silently answered about " +
          "somebody else.",
      ),
  })
  .strict();
