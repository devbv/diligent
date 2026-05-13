// @summary Declares the Studio RPC method for publishing the current world to OVERDARE.
import { z } from "zod";

export const method = "level.publish";

export const description =
  "Publish the world currently being edited to the OVERDARE platform. Studio itself opens the web approval " +
  "page in a browser; the JSON-RPC response is only `{ success: true }` and does NOT contain a URL. " +
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
});
