import { z } from "zod";

export const method = "asset_drawer.import";

export const description =
  "Import an asset from Asset Drawer (Asset Store) into the level while preserving its original hierarchy.";

export const params = z.object({
  assetid: z.string().describe('Asset Drawer asset id, e.g. "ovdrassetid://12345"'),
  assetName: z.string().describe("Asset name shown in Asset Drawer"),
  assetType: z.enum(["MODEL"]).describe("Imported asset type"),
});
