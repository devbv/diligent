// @summary Tests includeGui defaulting and schema validation for game.screenshot.

import { describe, expect, test } from "bun:test";
import { normalizeArgs, params } from "../../../../src/tools/studiorpc/methods/game.screenshot";

describe("game.screenshot includeGui", () => {
  test("defaults includeGui to true when omitted", () => {
    expect(normalizeArgs({})).toEqual({ includeGui: true });
    expect(normalizeArgs({ captureType: "Viewport" })).toEqual({ captureType: "Viewport", includeGui: true });
  });

  test("preserves an explicit includeGui: false", () => {
    expect(normalizeArgs({ includeGui: false })).toEqual({ includeGui: false });
  });

  test("schema accepts includeGui and rejects unknown keys", () => {
    expect(params.parse({ includeGui: false })).toEqual({ includeGui: false });
    expect(() => params.parse({ size: { width: 1, height: 1 } })).toThrow();
  });
});
