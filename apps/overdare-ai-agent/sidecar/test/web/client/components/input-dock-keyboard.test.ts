// @summary Tests for InputDock Enter-key action selection

import { expect, test } from "bun:test";
import { getComposerEnterAction } from "../../../../src/web/client/components/InputDock";

test("does not send on Enter when composer cannot send", () => {
  expect(
    getComposerEnterAction({
      hasBlockingPrompt: false,
      isBusy: false,
      canSend: false,
      canSteer: false,
      isUploadingImages: false,
      hasProvider: true,
    }),
  ).toBe("none");
});

test("does not steer on Enter when steering is unavailable", () => {
  expect(
    getComposerEnterAction({
      hasBlockingPrompt: false,
      isBusy: true,
      canSend: false,
      canSteer: false,
      isUploadingImages: false,
      hasProvider: true,
    }),
  ).toBe("none");
});

test("blocks Enter while prompt UI is pending", () => {
  expect(
    getComposerEnterAction({
      hasBlockingPrompt: true,
      isBusy: false,
      canSend: true,
      canSteer: true,
      isUploadingImages: false,
      hasProvider: true,
    }),
  ).toBe("none");
});

test("allows Enter only when the matching action is available", () => {
  expect(
    getComposerEnterAction({
      hasBlockingPrompt: false,
      isBusy: false,
      canSend: true,
      canSteer: false,
      isUploadingImages: false,
      hasProvider: true,
    }),
  ).toBe("send");

  expect(
    getComposerEnterAction({
      hasBlockingPrompt: false,
      isBusy: true,
      canSend: false,
      canSteer: true,
      isUploadingImages: false,
      hasProvider: true,
    }),
  ).toBe("steer");
});
