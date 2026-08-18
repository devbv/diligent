// @summary Declares the Studio RPC method for listing the UI on screen during a play test.
import { z } from "zod";

export const method = "game.ui.browse";

export const description =
  "List the UI that is on screen in the running play test, with the rectangle each element occupies. " +
  "Use it to find out what is on screen and what it is called. To click one of these, you do not need to " +
  "come back here for its rect: pass the name straight to studiorpc_game_input_inject as a pointerButton " +
  "target and Studio resolves it against this same layout walk. Rects are still here in the same " +
  "viewport-normalized 0..1 coordinates the pointer takes, for clicking a specific point rather than a " +
  "specific control — which is how you find out that a button sits somewhere a player cannot reach. " +
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
  "Text elements also report contrast and readable — a WCAG verdict on the text against its OWN " +
  "background, and nothing more than that — alongside occludedBy and occludedFraction, which name what is " +
  "painted on top of them and how much of the rectangle it covers. Read the two together. A label can be " +
  "visible, onScreen, readable: true at contrast 13 and still unreadable on screen because a button sits " +
  "over its right-hand third; that exact combination hid a countdown from a play test that had queried " +
  "every one of those fields. occludedFraction is area, so it says how much is covered and not which words " +
  "went — take a screenshot when the answer needs to be the words. " +
  "paths and fields narrow what comes back. A full HUD is around 11 KB of styling, which is worth paying " +
  "once to learn the screen and not worth paying again to read two label strings. Occlusion and onScreen " +
  "are still computed against the whole tree before anything is dropped, so a filtered element still " +
  "reports being covered by a sibling this response left out. A selector that matches nothing is named " +
  "back in projection.selectorsThatMatchedNothing rather than leaving an empty list to be read as an " +
  "empty screen. " +
  "When you also want the character or some instances from the same moment, ask studiorpc_game_observe " +
  "instead of calling this and then those: it takes these same paths and fields, and the sections it " +
  "returns are gathered in one game tick rather than seconds apart.";

export const params = z
  .object({
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Only return these elements. Each entry is a name, a full path, or an on-screen label — the same " +
          "three forms studiorpc_game_input_inject's target accepts. A trailing .* takes a container and " +
          'everything under it: "IncidentLog.*" is the frame plus its rows.',
      ),
    fields: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Only return these fields of each element. path and class always come back. Everything else is " +
          "opt-in: rect, center, instanceGuid, text, textColor, backgroundColor, contrast, " +
          "contrastThreshold, readable, zIndex, visible, onScreen, occludedBy, occludedFraction, and for a " +
          "ScrollingFrame canvasPosition, canvasSize, windowSize, canvasPositionMax, scrolledToEnd, " +
          "scrollingEnabled.",
      ),
  })
  .strict();
