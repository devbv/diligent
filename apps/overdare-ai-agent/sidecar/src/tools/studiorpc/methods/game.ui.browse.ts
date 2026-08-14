// @summary Declares the Studio RPC method for listing the UI on screen during a play test.
import { z } from "zod";

export const method = "game.ui.browse";

export const description =
  "List the UI that is on screen in the running play test, with the rectangle each element occupies. " +
  "Use it before clicking anything: read the element you want, take the center of its rect, and pass that " +
  "to studiorpc_game_input_inject as a pointerMove followed by a left pointerButton press — the rect is in " +
  "the same viewport-normalized 0..1 coordinates, so no measuring off a screenshot is involved. " +
  "Check onScreen before clicking: it is false when the element is hidden, when an ancestor is hidden, or " +
  "when its rect falls outside the viewport — all cases where the pixels are not there to be hit. " +
  "visible is the element's own flag, so an element can be visible: true and onScreen: false because its " +
  "parent is switched off or it sits past the edge. " +
  "rect comes from the authored position rather than measured pixels, so it stays correct for hidden and " +
  "off-screen elements too; the exception is elements positioned by a UIListLayout or UIGridLayout, whose " +
  "authored position the layout overrides. " +
  "path is the runtime address (for example PlayerGui.MainMenu.StartButton) and is the one to use. " +
  "guid identifies the live runtime copy and is NOT the editor guid: StarterGui is cloned into PlayerGui " +
  "when play starts, so the clone gets a fresh guid every run, and UI a script builds at runtime has no " +
  "editor counterpart at all. Do not feed a guid from here to studiorpc_instance_read or the editing tools. " +
  "zIndex is the authored draw order; among overlapping siblings the higher one is drawn in front. " +
  "This is the play-test counterpart of studiorpc_level_browse and needs a play test to be running.";

export const params = z.object({}).strict();
