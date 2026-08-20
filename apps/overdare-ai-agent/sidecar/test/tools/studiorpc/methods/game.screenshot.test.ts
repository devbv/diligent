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
import { StudioRpcError } from "../../../../src/tools/studiorpc/rpc";

const IMAGE = { width: 998, height: 735 };

function shot(
  position: { X: number; Y: number; Z: number },
  orientation: { X: number; Y: number; Z: number },
  extra: Record<string, unknown> = {},
) {
  return {
    success: true,
    image: IMAGE,
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
const LEVEL_SHOT = shot({ X: 0, Y: 340, Z: 900 }, { X: -0.9548412561416626, Y: 0, Z: 0 });
const ANGLED_SHOT = shot({ X: 620, Y: 430, Z: 640 }, { X: -6.243453502655029, Y: 43.63607406616211, Z: 0 });
function located(result: unknown, index = 0) {
  const list = (result as { located: Record<string, unknown>[] }).located;
  return list[index];
}
function pixelOf(entry: unknown): { x: number; y: number } {
  const { normalized } = entry as { normalized: { x: number; y: number } };
  return { x: normalized.x * IMAGE.width, y: normalized.y * IMAGE.height };
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
      const entry = located(result, index) as { label: string; onScreen: boolean };
      const pixel = pixelOf(entry);
      expect(entry.label).toBe(label);
      expect(entry.onScreen).toBe(true);
      expect(Math.hypot(pixel.x - px, pixel.y - py)).toBeLessThan(3);
    });
  });

  test("holds under yaw, which is where a mirrored right vector would show up", async () => {
    const result = await postProcess(ANGLED_SHOT, {
      locate: [
        { x: -420, y: 320, z: 420 },
        { x: 420, y: 320, z: -420 },
      ],
    });
    const first = pixelOf(located(result, 0));
    const second = pixelOf(located(result, 1));
    expect(Math.hypot(first.x - 159.1, first.y - 375.2)).toBeLessThan(3);
    expect(Math.hypot(second.x - 819.7, second.y - 373.2)).toBeLessThan(3);
  });

  test("normalized output is what input_inject takes, so it stays a 0..1 fraction", async () => {
    const result = await postProcess(LEVEL_SHOT, { locate: [{ x: 420, y: 320, z: 420 }] });
    const entry = located(result) as { normalized: { x: number; y: number } };
    expect(entry.normalized.x).toBeGreaterThan(0);
    expect(entry.normalized.x).toBeLessThan(1);
    expect(entry.normalized.y).toBeGreaterThan(0);
    expect(entry.normalized.y).toBeLessThan(1);
    const pixel = pixelOf(entry);
    expect(Math.hypot(pixel.x - 937.1, pixel.y - 379.8)).toBeLessThan(3);
  });

  test("a point behind the camera or outside the frustum is not on screen", async () => {
    const behind = await postProcess(LEVEL_SHOT, { locate: [{ x: 0, y: 340, z: 1600 }] });
    expect((located(behind) as { onScreen: boolean }).onScreen).toBe(false);
    const outside = await postProcess(LEVEL_SHOT, { locate: [{ x: -4000, y: 320, z: 420 }] });
    expect((located(outside) as { onScreen: boolean }).onScreen).toBe(false);
  });
});

describe("game.screenshot plumbing", () => {
  test("locate never reaches Studio, which does not implement it", () => {
    const sent = normalizeArgs({ includeGui: true, locate: [{ x: 1, y: 2, z: 3 }] });
    expect(sent).toEqual({ includeGui: true });
  });

  test("the UI is in the shot unless the call says otherwise", () => {
    expect(normalizeArgs({})).toEqual({ includeGui: true });
    expect(normalizeArgs({ includeGui: false })).toEqual({ includeGui: false });
  });

  test("locate takes positions and names in one list", () => {
    expect(() => params.parse({ locate: [{ x: 1, y: 2, z: 3, label: "a" }] })).not.toThrow();
    expect(() => params.parse({ locate: ["Gate", "Workspace.Lane.Gate"] })).not.toThrow();
    expect(() => params.parse({ locate: ["Gate", { x: 1, y: 2, z: 3 }] })).not.toThrow();
    expect(() => params.parse({ locateNames: ["Gate"] })).toThrow();
    expect(() => params.parse({ captureType: "Viewport" })).toThrow();
    expect(() => params.parse({ pixelToGround: [{ x: 1, y: 2 }] })).toThrow();
    expect(() => params.parse({ nope: 1 })).toThrow();
  });

  test("the picture comes back with the answer, not as a path to go and fetch", async () => {
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
    expect(await attachImages({ success: true, path: join(tmpdir(), "no-such-shot.png") })).toBeUndefined();
    expect(await attachImages({ success: true })).toBeUndefined();
    expect(await attachImages("not a result at all")).toBeUndefined();
  });

  test("a name that is not there is answered under the parameter that asked", async () => {
    const calls: string[] = [];
    const callRpc = async (method: string) => {
      calls.push(method);
      if (method === "game.instance.read") {
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

  test("saved-level paths resolve exact duplicates and share one browse", async () => {
    let browseCalls = 0;
    const callRpc = async (method: string, params: Record<string, unknown>) => {
      if (method === "game.instance.read") {
        throw new StudioRpcError("PIE is not running", -32150, { name: "pieNotRunning" });
      }
      if (method === "level.browse") {
        browseCalls += 1;
        return {
          level: [
            {
              Name: "Glasshouse",
              LuaChildren: [
                { Name: "RackA", LuaChildren: [{ Name: "Pot", ActorGuid: "pot-a" }] },
                { Name: "RackB", LuaChildren: [{ Name: "Pot", ActorGuid: "pot-b" }] },
              ],
            },
          ],
        };
      }
      if (method === "instance.read") {
        const x = params.ActorGuid === "pot-a" ? -100 : 100;
        return { CFrame: { Position: { X: x, Y: 340, Z: 0 } }, Size: { X: 20, Y: 20, Z: 20 } };
      }
      throw new Error(`unexpected method ${method}`);
    };

    const out = (await postProcess(
      LEVEL_SHOT,
      { locate: ["Glasshouse.RackA.Pot", "Glasshouse.RackB.Pot"] },
      callRpc,
    )) as { located: Array<{ label: string; world: { x: number } }> };

    expect(out.located.map((entry) => [entry.label, entry.world.x])).toEqual([
      ["Glasshouse.RackA.Pot", -100],
      ["Glasshouse.RackB.Pot", 100],
    ]);
    expect(browseCalls).toBe(1);
  });
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
