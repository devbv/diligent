// @summary Imports many Asset Drawer assets in one approved batch and returns the
// assetid→guids map that placement recipes depend on.

import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { WriteLock } from "../write-lock";

const TOOL_NAME = "studiorpc_asset_drawer_import_bulk";

export const description =
  "Import multiple assets from Asset Drawer (Asset Store) into the level in one approved batch. " +
  "MODEL type only. Returns an assetid→guids map; use those GUIDs (never scene names, which differ " +
  "from store titles) to locate the imported models for placement. For a single asset use " +
  "studiorpc_asset_drawer_import instead.";

export const params = z.object({
  assets: z
    .array(
      z.object({
        assetid: z.string().describe('Asset Drawer asset id, e.g. "ovdrassetid://12345"'),
        assetName: z.string().describe("Asset name shown in Asset Drawer"),
      }),
    )
    .min(2)
    .max(200)
    .describe("Assets to import in one approved batch."),
});

interface ImportedEntry {
  assetid: string;
  assetName: string;
  guids: string[];
}

interface FailedEntry {
  assetid: string;
  assetName: string;
  error: string;
}

export function createAssetDrawerImportBulkTool(callRpc: typeof call, writeLock: WriteLock): Tool {
  return {
    name: TOOL_NAME,
    description,
    parameters: params,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = params.parse(args);

      const approval = await ctx.approve({
        permission: "execute",
        toolName: TOOL_NAME,
        description: `Import ${parsed.assets.length} assets from Asset Drawer`,
        details: { assets: parsed.assets },
      });
      if (approval === "reject") {
        return {
          output: "[Rejected by user]",
          metadata: { error: true, method: "asset_drawer.import" },
        };
      }

      const release = await writeLock.acquire();
      try {
        const imported: ImportedEntry[] = [];
        const failed: FailedEntry[] = [];

        // Studio is a single-document editor: imports run sequentially, and one
        // failing asset must not abort the rest of the batch.
        for (const asset of parsed.assets) {
          try {
            const result = (await callRpc("asset_drawer.import", {
              assetid: asset.assetid,
              assetName: asset.assetName,
              assetType: "MODEL",
            })) as { guids?: string[] } | undefined;
            imported.push({ ...asset, guids: result?.guids ?? [] });
          } catch (error) {
            failed.push({ ...asset, error: (error as Error).message });
          }
        }

        // Same as single import (savingMethods): flush editor state once per batch.
        if (imported.length > 0) {
          await callRpc("level.save.file", {});
        }

        return {
          output: JSON.stringify({ imported, failed }, null, 2),
          metadata: {
            method: "asset_drawer.import",
            importedCount: imported.length,
            failedCount: failed.length,
          },
        };
      } finally {
        release();
      }
    },
  };
}
