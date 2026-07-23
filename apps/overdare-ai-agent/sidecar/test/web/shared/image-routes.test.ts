// @summary Tests shared persisted-image route encoding and decoding helpers for the Web frontend
import { expect, test } from "bun:test";
import {
  decodeWebImageRelativePath,
  toWebImageUrl,
  WEB_IMAGE_ROUTE_PREFIX,
} from "../../../src/web/shared/image-routes";

test("toWebImageUrl converts persisted local image paths to encoded route URLs", () => {
  expect(toWebImageUrl("/repo/.diligent/images/thread-1/shot 1.png")).toBe(
    `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot%201.png`,
  );
  expect(toWebImageUrl("/repo/.overdare/images/thread-1/shot 2.png")).toBe(
    `${WEB_IMAGE_ROUTE_PREFIX}thread-1/shot%202.png`,
  );
});

test("toWebImageUrl leaves non-diligent paths unchanged", () => {
  expect(toWebImageUrl("/tmp/shot.png")).toBe("/tmp/shot.png");
  expect(toWebImageUrl("/repo/images/shot.png")).toBe("/repo/images/shot.png");
});

test("decodeWebImageRelativePath decodes encoded route segments", () => {
  expect(decodeWebImageRelativePath(`${WEB_IMAGE_ROUTE_PREFIX}drafts/folder%20a/%23hash.png`)).toBe(
    "drafts/folder a/#hash.png",
  );
});

test("decodeWebImageRelativePath rejects malformed URLs", () => {
  expect(decodeWebImageRelativePath(`${WEB_IMAGE_ROUTE_PREFIX}%E0%A4%A`)).toBeNull();
});
