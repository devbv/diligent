// @summary Tests world/pixel conversion on screenshots against poses measured in a live Studio.

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachImages,
  normalizeArgs,
  params,
  postProcess,
} from "../../../../src/tools/studiorpc/methods/game.screenshot";

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
  test("projects world points onto the pixels they were photographed at", async () => {
    const result = await postProcess(LEVEL_SHOT, {
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

  test("holds under yaw, which is where a mirrored right vector would show up", async () => {
    const result = await postProcess(ANGLED_SHOT, {
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

  test("normalized output is what input_inject takes, so it stays a 0..1 fraction", async () => {
    const result = await postProcess(LEVEL_SHOT, { locate: [{ x: 420, y: 320, z: 420 }] });
    const entry = located(result) as { normalized: { x: number; y: number }; pixel: { x: number; y: number } };
    expect(entry.normalized.x).toBeCloseTo(entry.pixel.x / 998, 3);
    expect(entry.normalized.y).toBeCloseTo(entry.pixel.y / 735, 3);
  });

  test("a point behind the camera is reported, not folded back into the frame", async () => {
    const result = await postProcess(LEVEL_SHOT, { locate: [{ x: 0, y: 340, z: 1600 }] });
    const entry = located(result) as { onScreen: boolean; behindCamera: boolean };
    expect(entry.behindCamera).toBe(true);
    expect(entry.onScreen).toBe(false);
  });

  test("a point outside the frustum is off screen but not behind the camera", async () => {
    const result = await postProcess(LEVEL_SHOT, { locate: [{ x: -4000, y: 320, z: 420 }] });
    const entry = located(result) as { onScreen: boolean; behindCamera: boolean };
    expect(entry.behindCamera).toBe(false);
    expect(entry.onScreen).toBe(false);
  });
});

describe("game.screenshot pixelToGround", () => {
  test("recovers the world points that pads were photographed at", async () => {
    const result = (await postProcess(TOPDOWN_SHOT, {
      pixelToGround: [
        { x: 120, y: 200 },
        { x: 860, y: 220 },
        { x: 300, y: 600 },
        { x: 700, y: 640 },
        { x: 499, y: 400 },
      ],
    })) as { groundPoints: { world: { x: number; z: number } }[] };
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

  test("round trips back to the pixel it came from", async () => {
    const ground = (await postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600 }] })) as {
      groundPoints: { world: { x: number; y: number; z: number } }[];
    };
    const back = await postProcess(TOPDOWN_SHOT, { locate: [ground.groundPoints[0].world] });
    const entry = located(back) as { pixel: { x: number; y: number } };
    expect(entry.pixel.x).toBeCloseTo(300, 0);
    expect(entry.pixel.y).toBeCloseTo(600, 0);
  });

  test("a pixel above the horizon reports no hit instead of a point behind the camera", async () => {
    const result = (await postProcess(LEVEL_SHOT, { pixelToGround: [{ x: 499, y: 5 }] })) as {
      groundPoints: { world: unknown; note?: string }[];
    };
    expect(result.groundPoints[0].world).toBeNull();
    expect(result.groundPoints[0].note).toContain("never meets that plane");
  });

  test("planeY lifts the plane off the floor", async () => {
    const floor = (await postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600 }] })) as {
      groundPoints: { world: { y: number } }[];
    };
    const raised = (await postProcess(TOPDOWN_SHOT, { pixelToGround: [{ x: 300, y: 600, planeY: 100 }] })) as {
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

  test("the UI is in the shot unless the call says otherwise", () => {
    // Studio renders the world alone by default, which 255 of 290 measured captures then had to
    // ask out of. An explicit false still has to survive the defaulting.
    expect(normalizeArgs({})).toEqual({ includeGui: true });
    expect(normalizeArgs({ includeGui: false })).toEqual({ includeGui: false });
  });

  test("locate takes positions and names in one list", () => {
    expect(() => params.parse({ locate: [{ x: 1, y: 2, z: 3, label: "a" }] })).not.toThrow();
    expect(() => params.parse({ locate: ["Gate", "Workspace.Lane.Gate"] })).not.toThrow();
    expect(() => params.parse({ locate: ["Gate", { x: 1, y: 2, z: 3 }] })).not.toThrow();
    // locateNames was the second spelling of the same request; no measured call used both.
    expect(() => params.parse({ locateNames: ["Gate"] })).toThrow();
    // captureType had one legal value and was never passed in 290 captures.
    expect(() => params.parse({ captureType: "Viewport" })).toThrow();
    expect(() => params.parse({ pixelToGround: [{ x: 1, y: 2, planeY: 5 }] })).not.toThrow();
    expect(() => params.parse({ nope: 1 })).toThrow();
  });

  test("the picture comes back with the answer, not as a path to go and fetch", async () => {
    // Measured across the run archive: 294 captures, 274 followed within three calls by reading
    // the file back. The second call was not a choice a caller made, it was what a look cost.
    const file = join(tmpdir(), `screenshot-attach-${process.pid}.png`);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      const images = await attachImages({ success: true, path: file });
      expect(images).toHaveLength(1);
      expect(images?.[0].source.media_type).toBe("image/png");
      expect(images?.[0].source.data).toBe("iVBORw0KGgo=");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("a picture that cannot be read leaves the rest of the answer standing", async () => {
    // The path, the camera and the projections each answer a question on their own, and a capture
    // whose file is gone is not a failed capture.
    expect(await attachImages({ success: true, path: join(tmpdir(), "no-such-shot.png") })).toBeUndefined();
    expect(await attachImages({ success: true })).toBeUndefined();
    expect(await attachImages("not a result at all")).toBeUndefined();
  });

  test("a name that is not there is answered under the parameter that asked", async () => {
    // The reply used to say locateNamesNotFound while the parameter was `locate`. A caller
    // reading a key that names a parameter it cannot find goes looking for that parameter, which
    // is the same call move_to lost when it took `target` and echoed `targetPath`.
    const calls: string[] = [];
    const callRpc = async (method: string) => {
      calls.push(method);
      if (method === "game.instance.read") {
        // The listing call, and the lookup that answers "not in the running Workspace".
        if (calls.filter((entry) => entry === "game.instance.read").length > 1) {
          return { instances: [{ name: "Gate" }, { name: "Lever" }] };
        }
        throw new Error('No instance named "Gaet" is in the running Workspace.');
      }
      return { instances: [] };
    };

    const out = (await postProcess(LEVEL_SHOT, { locate: ["Gaet"] }, callRpc as never)) as Record<string, unknown>;

    expect(out.locateNotFound).toEqual(["Gaet"]);
    expect(out.locateNote).toContain("Gate");
    expect(out.locateNamesNotFound).toBeUndefined();
  });

  // Untouched apart from the camera axes, which every shot gets: whoever reads a camera is
  // usually about to answer a question phrased against the screen, and deriving those by hand
  // is where the sign of `right` flips.
  test("a shot with no locate request comes back with nothing added but the camera axes", async () => {
    const out = (await postProcess(LEVEL_SHOT, { includeGui: false })) as Record<string, unknown> & {
      camera: Record<string, unknown>;
    };
    expect(Object.keys(out).sort()).toEqual(Object.keys(LEVEL_SHOT).sort());
    expect(out.image).toEqual(LEVEL_SHOT.image);
    expect(out.camera.axes).toBeDefined();
    const { axes: _axes, ...restOfCamera } = out.camera;
    expect(restOfCamera).toEqual(LEVEL_SHOT.camera);
  });

  test("an orthographic camera is refused rather than answered with perspective math", async () => {
    const ortho = shot({ X: 0, Y: 340, Z: 900 }, { X: 0, Y: 0, Z: 0 }, { projection: "orthographic" });
    const result = (await postProcess(ortho, { locate: [{ x: 0, y: 0, z: 0 }] })) as { locateError?: string };
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

  test("says so on a plain shot, with no geometry asked for", async () => {
    const out = (await postProcess(stretched, {})) as { imageAspectNote?: string };
    expect(out.imageAspectNote).toContain("998x735");
    expect(out.imageAspectNote).toContain("Normalized coordinates are unaffected");
  });

  test("stays quiet when the image matches what the camera saw", async () => {
    const matched = { ...stretched, camera: { ...stretched.camera, aspectRatio: 998 / 735 } };
    const out = (await postProcess(matched, {})) as { imageAspectNote?: string };
    expect(out.imageAspectNote).toBeUndefined();
  });

  test("says so alongside a locate as well", async () => {
    const out = (await postProcess(stretched, { locate: [{ x: 0, y: 100, z: -500 }] })) as {
      imageAspectNote?: string;
      located: unknown[];
    };
    expect(out.imageAspectNote).toContain("squeezed horizontally");
    expect(out.located).toHaveLength(1);
  });
});

describe("game.screenshot camera placement", () => {
  test("placing the camera is one parameter, because half of it is not a request", () => {
    // `cameraPosition` and `lookAt` had to be given together — a pair an agent can get half
    // right, which is the failure mode that made move_to unusable. One object cannot be.
    expect(() =>
      params.parse({ camera: { position: { x: 0, y: 10, z: 0 }, lookAt: { x: 0, y: 0, z: 100 } } }),
    ).not.toThrow();
    expect(() => params.parse({ camera: { position: { x: 0, y: 10, z: 0 } } })).toThrow();
    expect(() => params.parse({ cameraPosition: { x: 0, y: 10, z: 0 } })).toThrow();
    expect(() => params.parse({ lookAt: { x: 0, y: 0, z: 100 } })).toThrow();
  });

  test("Studio still receives the two fields it knows", () => {
    expect(normalizeArgs({ camera: { position: { x: 1, y: 2, z: 3 }, lookAt: { x: 4, y: 5, z: 6 } } })).toEqual({
      includeGui: true,
      cameraPosition: { x: 1, y: 2, z: 3 },
      lookAt: { x: 4, y: 5, z: 6 },
    });
  });
});
