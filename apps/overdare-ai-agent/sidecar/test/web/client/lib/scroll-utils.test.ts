// @summary Tests for near-bottom scroll detection helper used by chat auto-follow

import { expect, test } from "bun:test";
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX, isNearBottom } from "../../../../src/web/client/lib/scroll-utils";

test("isNearBottom returns true when distance from bottom is less than threshold", () => {
  expect(
    isNearBottom({
      scrollHeight: 1000,
      scrollTop: 781,
      clientHeight: 100,
    }),
  ).toBe(true);
});

test("isNearBottom returns true when distance from bottom is exactly threshold", () => {
  expect(
    isNearBottom({
      scrollHeight: 1000,
      scrollTop: 780,
      clientHeight: 100,
    }),
  ).toBe(true);
});

test("isNearBottom returns false when distance from bottom is above threshold", () => {
  expect(
    isNearBottom({
      scrollHeight: 1000,
      scrollTop: 779,
      clientHeight: 100,
    }),
  ).toBe(false);
});

test("isNearBottom supports custom threshold override", () => {
  expect(CHAT_NEAR_BOTTOM_THRESHOLD_PX).toBe(120);
  expect(
    isNearBottom(
      {
        scrollHeight: 1000,
        scrollTop: 850,
        clientHeight: 100,
      },
      50,
    ),
  ).toBe(true);
});
