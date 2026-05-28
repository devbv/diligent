// @summary Registers generic Studio RPC method modules and their render builders.

import type { z } from "zod";
import * as actionSequencerApplyJson from "./methods/action-sequencer-service.apply-json";
import * as assetDrawerImport from "./methods/asset-drawer.import";
import * as assetManagerImageImport from "./methods/asset-manager.image.import";
import * as gamePlay from "./methods/game.play";
import * as gameScreenshot from "./methods/game.screenshot";
import * as gameStop from "./methods/game.stop";
import * as hubTokenRead from "./methods/hub.token.read";
import * as levelBrowse from "./methods/level.browse";
import * as levelPublish from "./methods/level.publish";
import * as levelSaveFile from "./methods/level.save.file";
// biome-ignore lint/correctness/noUnusedImports: script.add moved to tools/script-add-tool.ts
import * as _scriptAdd from "./methods/script.add";
// biome-ignore lint/correctness/noUnusedImports: script.delete moved to tools/script-delete-tool.ts
import * as _scriptDelete from "./methods/script.delete";
import {
  buildActionSequencerApplyJsonRender,
  buildAssetDrawerImportRender,
  buildAssetManagerImageImportRender,
  buildGamePlayRender,
  buildGameScreenshotRender,
  buildGameStopRender,
  buildHubTokenReadRender,
  buildInstanceDeleteRender,
  buildInstanceMoveRender,
  buildInstanceReadRender,
  buildInstanceUpsertRender,
  buildLevelBrowseRender,
  buildLevelPublishRender,
  buildLevelSaveFileRender,
} from "./render";
import type { ToolRenderPayload } from "./types";

type MethodModule = {
  method: string;
  description: string;
  params: z.ZodType;
  resolveMethod?: (args: Record<string, unknown>) => string;
  normalizeArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  postProcess?: (result: unknown, args: Record<string, unknown>) => unknown;
};

type RenderBuilder = (ctx: {
  args: Record<string, unknown>;
  normalizedArgs: Record<string, unknown>;
  output: string;
  result: unknown;
}) => ToolRenderPayload | undefined;

export const methodModules: MethodModule[] = [
  assetDrawerImport,
  assetManagerImageImport,
  actionSequencerApplyJson,
  levelBrowse,
  levelSaveFile,
  levelPublish,
  gamePlay,
  gameStop,
  gameScreenshot,
  hubTokenRead,
];

/** Methods that mutate the level and should trigger an automatic save after execution. */
export const mutatingMethods = new Set([
  assetDrawerImport.method,
  assetManagerImageImport.method,
  actionSequencerApplyJson.method,
]);

export const renderBuilders: Record<string, RenderBuilder> = {
  studiorpc_asset_drawer_import: ({ normalizedArgs, output }) => buildAssetDrawerImportRender(normalizedArgs, output),
  studiorpc_asset_manager_image_import: ({ normalizedArgs, output, result }) =>
    buildAssetManagerImageImportRender(result, normalizedArgs, output),
  studiorpc_action_sequencer_service_apply_json: ({ normalizedArgs, output }) =>
    buildActionSequencerApplyJsonRender(normalizedArgs, output),
  studiorpc_level_browse: ({ args, result }) => buildLevelBrowseRender(result, args),
  studiorpc_level_save_file: ({ output }) => buildLevelSaveFileRender(output),
  studiorpc_instance_read: ({ normalizedArgs, output }) => buildInstanceReadRender(normalizedArgs, output),
  studiorpc_instance_upsert: ({ normalizedArgs, output }) => buildInstanceUpsertRender(normalizedArgs, output),
  studiorpc_instance_delete: ({ normalizedArgs, output }) => buildInstanceDeleteRender(normalizedArgs, output),
  studiorpc_instance_move: ({ normalizedArgs, output }) => buildInstanceMoveRender(normalizedArgs, output),
  studiorpc_game_play: ({ normalizedArgs, output }) => buildGamePlayRender(normalizedArgs, output),
  studiorpc_game_stop: ({ output }) => buildGameStopRender(output),
  studiorpc_game_screenshot: ({ normalizedArgs, output, result }) =>
    buildGameScreenshotRender(result, normalizedArgs, output),
  studiorpc_level_publish: ({ normalizedArgs, output, result }) =>
    buildLevelPublishRender(result, normalizedArgs, output),
  studiorpc_hub_token_read: ({ output, result }) => buildHubTokenReadRender(result, output),
};
