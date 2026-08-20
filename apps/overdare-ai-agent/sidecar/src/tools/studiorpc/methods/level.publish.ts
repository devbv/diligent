// @summary Declares the Studio RPC method for publishing the current world to OVERDARE.
import { z } from "zod";

export const method = "level.publish";
export const timeoutMs = 300_000;

export const description =
  "Publish the world currently being edited to the OVERDARE platform. On success, Studio always returns a structured " +
  "publish result containing uploaded build/source/thumbnail/screenshot URLs and world/place identifiers. " +
  "By default, Studio also opens the web approval page in a browser. " +
  "This can take longer than ordinary Studio RPC calls because the user may need to review the browser/Studio UI " +
  "and click confirmation buttons before Studio returns the publish result. " +
  "Set skipCreatorHubLaunch to true only for fully automated end-to-end publishing that must not open the browser. " +
  "Omitting skipCreatorHubLaunch, or setting it to false, preserves the existing browser flow. " +
  "All params are optional — calling with empty params is valid. " +
  "On the FIRST publish, worldName/description/category/keyword (if provided) are persisted as the world's metadata. " +
  "On SUBSEQUENT publishes (Update), Studio uploads new S3 resources but ignores these metadata params — " +
  "to change metadata afterwards the user must edit it on the OVERDARE web admin page. " +
  "Error -32009 means the user canceled the publish in the Studio UI — treat it as a final outcome and do NOT retry automatically.";

export const params = z.object({
  worldName: z.string().optional().describe("World display name. Only applied on the first publish."),
  description: z.string().optional().describe("World description. Only applied on the first publish."),
  category: z
    .array(z.string())
    .max(3)
    .optional()
    .describe("Up to 3 category tags (e.g. TPS, TPA, Action). Only applied on the first publish."),
  keyword: z
    .array(z.string())
    .max(5)
    .optional()
    .describe("Up to 5 search keywords. Only applied on the first publish."),
  skipCreatorHubLaunch: z
    .boolean()
    .optional()
    .describe(
      "Whether Studio should skip launching Creator Hub after producing the structured publish result. Defaults to false; set true only for fully automated end-to-end publishing.",
    ),
});
