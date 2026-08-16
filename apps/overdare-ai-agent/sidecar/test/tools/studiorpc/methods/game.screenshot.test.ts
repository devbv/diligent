// @summary Tests world/pixel conversion on screenshots against poses measured in a live Studio.

import { describe, expect, test } from "bun:test";
import { normalizeArgs, params, postProcess } from "../../../../src/tools/studiorpc/methods/game.screenshot";

/**
 * Ground truth from playtest2 on 2026-08-16. Five 40cm probe cubes at known world positions were
 * photographed from five poses, and their pixel centroids recovered by differencing the capture
 * against one taken with the probes hidden. Every projection below matched its measured centroid
 * to within 2.8px, so these expectations pin the convention, not just the arithmetic.
 */
function shot(
  position: { X: number; Y: number; Z: number },
  orientation: { X: number; Y: number; Z: number },
  extra: Record<string, unknown> = {},
) {
  return {
    success: true,
    image: { width: 998, height: 735 },
    camera: {
      CFrame: { Position: position, Orientation: orientation },
      projection: "perspective",
      fieldOfView: 90,
      aspectRatio: 1.357823133468628,
      ...extra,
    },
    source: "editorViewport",
  };
}

// Camera 900 units back from the origin, level, looking down -Z.
const LEVEL_SHOT = shot({ X: 0, Y: 340, Z: 900 }, { X: -0.9548412561416626, Y: 0, Z: 0 });
// Camera off to one corner: yaw 43.6 and a slight downward pitch.
const ANGLED_SHOT = shot({ X: 620, Y: 430, Z: 640 }, { X: -6.243453502655029, Y: 43.63607406616211, Z: 0 });
// Camera high and pitched 37.9 down at the origin.
const TOPDOWN_SHOT = shot({ X: 0, Y: 700, Z: 900 }, { X: -37.87498474121094, Y: 0, Z: 0 });

function located(result: unknown, index = 0) {
  const list = (result as { located: Record<string, unknown>[] }).located;
  return list[index];
}

describe("game.screenshot locate", () => {
  test("projects world points onto the pixels they were photographed at", () => {
    const result = postProcess(LEVEL_SHOT, {
      locate: [
        { x: -420, y: 320, z: 420, label: "nearLeft" },
        { x: 420, y: 320, z: 420, label: "nearRight" },
        { x: -420, y: 320, z: -420, label: "farLeft" },
        { x: 420, y: 320, z: -420, label: "farRight" },
        { x: 0, y: 700, z: 200, label: "overhead" },
      ],
    });
    const measured = [
      ["nearLeft", 59.9, 379.9],
      ["nearRight", 937.1, 379.8],
      ["farLeft", 339.4, 366.0],
      ["farRight", 657.6, 366.1],
      ["overhead", 498.5, 99.4],
    ] as const;
    measured.forEach(([label, px, py], index) => {
      const entry = located(result, index) as {
        label: string;
        pixel: { x: number; y: number };
        onScreen: boolean;
      };
      expect(entry.label).toBe(label);
      expect(entry.onScreen).toBe(true);
      expect(Math.hypot(entry.pixel.x - px, entry.pixel.y - py)).toBeLessThan(3);
    });
  });

  test("holds under yaw, which is where a mirrored right vector would show up", () => {
    const result = postProcess(ANGLED_SHOT, {
      locate: [
        { x: -420, y: 320, z: 420 },
        { x: 420, y: 320, z: -420 },
      ],
    });
    const first = located(result, 0) as { pixel: { x: number; y: number } };
    const second = located(result, 1) as { pixel: { x: number; y: number } };
    expect(Math.hypot(first.pixel.x - 159.1, first.pixel.y - 375.2)).toBeLessThan(3);
    expect(Math.hypot(second.pixel.x - 819.7, second.pixel.y - 373.2)).toBeLessThan(3);
  });

  test("normalized output is what input_inject takes, so it stays a 0..1 fraction", () => {
    const result = postProcess(LEVEL_SHOT, { locate: [{ x: 420, y: 320, z: 420 }] });
    const entry = located(result) as { normalized: { x: number; y: number }; pixel: { x: number; y: number } };
    expect(entry.normalized.x).toBeCloseTo(entry.pixel.x / 998, 3);
    expect(entry.normalized.y).toBeCloseTo(entry.pixel.y / 735, 3);
  });

  test("a point behind the camera is reported, not folded back into the frame", () => {
    const result = postProcess(LEVEL_SHOT, { locate: [{ x: 0, y: 340, z: 1600 }] });
    const entry = located(result) as { onScreen: boolean; behindCamera: boolean };
    expect(entry.behindCamera).toBe(true);
    expect(entry.onScreen).toBe(false);
  });

  test("a point outside the frustum is off screen but not behind the camera", () => {
    const result = postProcess(LEVEL_SHOT, { locate: [{ x: -4000, y: 320, z: 420 }] });
    const entry = located(result) as { onScreen: boolean; behindCamera: boolean };
    expect(entry.behindCamera).toBe(false);
    expect(entry.onScreen).toBe(false);
  });
});

describe("game.screenshot pixelToGround", () => {
  test("recovers the world points that pads were photographed at", () => {
    const result = postProcess(TOPDOWN_SHOT, {
      pixelToGround: [
        { x: 120, y: 200 },
        { x: 860, y: 220 },
        { x: 300, y: 600 },
        { x: 700, y: 640 },
        { x: 499, y: 400 },
      ],
    }) as { groundPoints: { world: { x: number; z: number } }[] };
    const measured = [
      [-1523.49, -1096.7],
      [1330.51, -885.48],
      [-284.35, 541.13],
      [269.82, 595.83],
      [0, 111.61],
    ];
    measured.forEach(([x, z], index) => {
      expect(result.groundPoints[index].world.x).toBeCloseTo(x, 1);
      expect(result.groundPoints[index].world.z).toBeCloseTo(z, 1);
    });
  });

  test("round trips back to the pixel it came from", () => {
    const ground = postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600 }] }) as {
      groundPoints: { world: { x: number; y: number; z: number } }[];
    };
    const back = postProcess(TOPDOWN_SHOT, { locate: [ground.groundPoints[0].world] });
    const entry = located(back) as { pixel: { x: number; y: number } };
    expect(entry.pixel.x).toBeCloseTo(300, 0);
    expect(entry.pixel.y).toBeCloseTo(600, 0);
  });

  test("a pixel above the horizon reports no hit instead of a point behind the camera", () => {
    const result = postProcess(LEVEL_SHOT, { pixelToGround: [{ x: 499, y: 5 }] }) as {
      groundPoints: { world: unknown; note?: string }[];
    };
    expect(result.groundPoints[0].world).toBeNull();
    expect(result.groundPoints[0].note).toContain("never meets that plane");
  });

  test("planeY lifts the plane off the floor", () => {
    const floor = postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600 }] }) as {
      groundPoints: { world: { y: number } }[];
    };
    const raised = postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600, planeY: 100 }] }) as {
      groundPoints: { world: { y: number } }[];
    };
    expect(floor.groundPoints[0].world.y).toBe(0);
    expect(raised.groundPoints[0].world.y).toBe(100);
  });
});

describe("game.screenshot plumbing", () => {
  test("defaults includeGui to true and preserves an explicit false", () => {
    expect(normalizeArgs({})).toEqual({ includeGui: true });
    expect(normalizeArgs({ captureType: "Viewport" })).toEqual({ captureType: "Viewport", includeGui: true });
    expect(normalizeArgs({ includeGui: false })).toEqual({ includeGui: false });
  });

  test("locate and pixelToGround never reach Studio, which does not implement them", () => {
    const sent = normalizeArgs({ includeGui: true, locate: [{ x: 1, y: 2, z: 3 }], pixelToGround: [{ x: 1, y: 2 }] });
    expect(sent).toEqual({ includeGui: true });
  });

  test("the params schema accepts both and still rejects unknown keys", () => {
    expect(() => params.parse({ locate: [{ x: 1, y: 2, z: 3, label: "a" }] })).not.toThrow();
    expect(() => params.parse({ pixelToGround: [{ x: 1, y: 2, planeY: 5 }] })).not.toThrow();
    expect(() => params.parse({ nope: 1 })).toThrow();
  });

  test("a shot with no locate request is passed through untouched", () => {
    expect(postProcess(LEVEL_SHOT, { includeGui: false })).toBe(LEVEL_SHOT);
  });

  test("an orthographic camera is refused rather than answered with perspective math", () => {
    const ortho = shot({ X: 0, Y: 340, Z: 900 }, { X: 0, Y: 0, Z: 0 }, { projection: "orthographic" });
    const result = postProcess(ortho, { locate: [{ x: 0, y: 0, z: 0 }] }) as { locateError?: string };
    expect(result.locateError).toContain("not perspective");
  });
});

describe("game.screenshot image proportions", () => {
  // Studio has always reported a captured size matching its aspectRatio, so this is a
  // guard rather than a live case: if the two ever part company, every proportion read
  // off the picture is wrong and so is the projection, which trusts aspectRatio.
  const stretched = {
    image: { width: 998, height: 735 },
    camera: {
      projection: "perspective",
      fieldOfView: 90,
      aspectRatio: 2.159,
      CFrame: { Position: { X: 0, Y: 100, Z: 0 }, Orientation: { X: 0, Y: 0, Z: 0 } },
    },
  };

  test("says so on a plain shot, with no geometry asked for", () => {
    const out = postProcess(stretched, {}) as { imageAspectNote?: string };
    expect(out.imageAspectNote).toContain("998x735");
    expect(out.imageAspectNote).toContain("Normalized coordinates are unaffected");
  });

  test("stays quiet when the image matches what the camera saw", () => {
    const matched = { ...stretched, camera: { ...stretched.camera, aspectRatio: 998 / 735 } };
    expect((postProcess(matched, {}) as { imageAspectNote?: string }).imageAspectNote).toBeUndefined();
  });

  test("says so alongside a locate as well", () => {
    const out = postProcess(stretched, { locate: [{ x: 0, y: 100, z: -500 }] }) as {
      imageAspectNote?: string;
      located: unknown[];
    };
    expect(out.imageAspectNote).toContain("squeezed horizontally");
    expect(out.located).toHaveLength(1);
  });
});
