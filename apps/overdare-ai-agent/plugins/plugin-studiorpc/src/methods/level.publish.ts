// @summary Declares the Studio RPC method for publishing the current world to OVERDARE.
import { z } from "zod";

export const method = "level.publish";

export const description =
  "Publish the world currently being edited to the OVERDARE platform and open the web approval page. " +
  "On the FIRST publish, worldName/description/category/keyword are persisted as the world's metadata. " +
  "On SUBSEQUENT publishes (Update), Studio uploads new S3 resources but ignores these metadata params — " +
  "to change metadata afterwards the user must edit it on the OVERDARE web admin page. " +
  "The success response includes a `url` that the user must open in a browser to finalize publishing; " +
  "always surface that URL to the user.";

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
