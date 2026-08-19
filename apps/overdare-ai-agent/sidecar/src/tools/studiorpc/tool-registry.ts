// @summary Registers generic Studio RPC method modules and their render builders.

import type { ImageBlock } from "@diligent/protocol";
import type { z } from "zod";
import * as actionSequencerApplyJson from "./methods/action-sequencer-service.apply-json";
import * as assetDrawerImport from "./methods/asset-drawer.import";
import * as assetManagerImageImport from "./methods/asset-manager.image.import";
import * as gameCharacterRead from "./methods/game.character.read";
import * as gameObserve from "./methods/game.observe";
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
import * as viewportCameraRead from "./methods/viewport.camera.read";
import * as viewportCameraSet from "./methods/viewport.camera.set";
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
  buildViewportCameraReadRender,
} from "./render";
import type { CallRpc } from "./tools/pie-input/target";
import type { ToolRenderPayload } from "./types";

type MethodModule = {
  method: string;
  description: string;
  params: z.ZodType;
  timeoutMs?: number;
  resolveMethod?: (args: Record<string, unknown>) => string;
  normalizeArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Run something before the RPC, for a method whose ordinary case is really two calls in a fixed
   * order. It sees the arguments as the caller wrote them, before normalizeArgs strips whatever
   * Studio does not know about.
   */
  preCall?: (args: Record<string, unknown>, callRpc: CallRpc) => Promise<void>;
  /**
   * Shape the answer after Studio returns it. It gets callRpc because some of what the caller
   * asked for is answerable only by asking Studio something else — resolving an instance name to
   * a position, for one — and making the caller do that round trip is the friction this removes.
   */
  postProcess?: (result: unknown, args: Record<string, unknown>, callRpc: CallRpc) => unknown | Promise<unknown>;
  /**
   * Turn a Studio error into an answer, where the failure is itself information the
   * caller asked for. Looking up a name that is not there is the case: absence is
   * the result of the question, and raising it makes every existence check an error
   * path. Return a replacement result, or rethrow to keep the error.
   */
  recover?: (error: unknown, args: Record<string, unknown>, callRpc: CallRpc) => Promise<unknown>;
  /**
   * Images to hand back with the answer. A tool that produces a picture and reports only where it
   * put it makes the caller fetch it: measured across 294 captures, 274 were followed within three
   * calls by reading the file back. The catalog downscales whatever comes out of here, so a tool
   * returns the picture at whatever size it has.
   */
  attachImages?: (result: unknown, args: Record<string, unknown>) => Promise<ImageBlock[] | undefined>;
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
  gameCharacterRead,
  // game.instance.read and game.ui.browse are not tools of their own any more, only sections of
  // game.observe — which is literally their handlers, wrapped. Measured across six full runs:
  // 64 observe calls, 6 ui_browse, 3 instance_read — and all three of those instance_read calls
  // carried `target` and `namePattern` and `class` and `under` together, the two-questions bug,
  // while observe's instances section never did it once because it offers no `target`. A third
  // name for the same handler bought nothing and cost that.
  gameObserve,
  viewportCameraRead,
  viewportCameraSet,
  hubTokenRead,
];

/** Methods that mutate the level and should be serialized with the write lock. */
export const mutatingMethods = new Set([
  assetDrawerImport.method,
  assetManagerImageImport.method,
  actionSequencerApplyJson.method,
]);

/**
 * Methods that change the live editor state and should immediately flush it to
 * file (level.save.file) once they succeed, so the change is persisted without
 * waiting for the turn-boundary save hook.
 */
export const savingMethods = new Set([assetDrawerImport.method, assetManagerImageImport.method]);

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
  studiorpc_viewport_camera_read: ({ output, result }) => buildViewportCameraReadRender(result, output),
  studiorpc_hub_token_read: ({ output, result }) => buildHubTokenReadRender(result, output),
};
