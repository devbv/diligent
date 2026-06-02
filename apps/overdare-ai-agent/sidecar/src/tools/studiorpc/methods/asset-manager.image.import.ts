import { z } from "zod";

export const method = "asset_manager.image.import";

export const description = "Import an external image file into the asset manager and return the created asset id.";

export const params = z.object({
  file: z.string().describe("Absolute file path to the image to import"),
});
