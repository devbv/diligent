// @summary Tests class-bound validation for Studio RPC instance upserts.

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../../../src/tools/studiorpc/methods/instance.upsert";

describe("instance.upsert class property validation", () => {
  test("rejects properties that belong to a different class", () => {
    expect(() =>
      parseArgs({
        items: [
          {
            class: "Part",
            parentGuid: "workspace",
            name: "NotATextLabel",
            properties: { Text: "invalid for Part" },
          },
        ],
      }),
    ).toThrow(/class=Part/);
  });

  test("accepts a partial update without injecting create defaults", () => {
    const parsed = parseArgs({
      items: [{ guid: "prompt", properties: { ActionText: "Open" } }],
    });

    expect(parsed.items[0]).toEqual({ guid: "prompt", properties: { ActionText: "Open" } });
  });

  const FIRE_RISE_PATH = "/CommonContent/VFX/Layer/0_Base/FireRise_A/VFX_UGC_Base_FireRise_A.VFX_UGC_Base_FireRise_A";

  test("accepts a VFXRecipe add with short source names and expands NiagaraSystem to the full path", () => {
    const parsed = parseArgs({
      items: [
        {
          class: "VFXRecipe",
          parentGuid: "workspace",
          name: "Explosion",
          properties: {
            BaseLayer: [
              {
                Name: "FireRise_A",
                NiagaraSystem: "FireRise_A",
                Position: { X: 0, Y: 0, Z: 0 },
                Color: [
                  { R: 255, G: 95, B: 19, Time: 0 },
                  { R: 3, G: 0, B: 0, Time: 1 },
                ],
                Texture: { Content: "ovdrassetid://2793112" },
                SpawnCount: 3,
              },
            ],
          },
        },
      ],
    });

    const properties = parsed.items[0].properties as Record<string, unknown>;
    expect(properties.AutoActivate).toBe(true);
    expect(properties.InfiniteLoop).toBe(true);
    expect(properties.LoopCount).toBe(1);
    const [source] = properties.BaseLayer as Record<string, unknown>[];
    expect(source.NiagaraSystem).toBe(FIRE_RISE_PATH);
    expect(source.Position).toEqual({ ObjectType: "Vector3", X: 0, Y: 0, Z: 0 });
    expect(source.Texture).toEqual({ ObjectType: "Content", Content: "ovdrassetid://2793112" });
    expect((source.Color as Record<string, unknown>[])[0]).toEqual({
      ObjectType: "Color3",
      R: 255,
      G: 95,
      B: 19,
      Time: 0,
    });
  });

  test("accepts a full serving-asset path and normalizes it to the same expanded path", () => {
    const parsed = parseArgs({
      items: [
        {
          class: "VFXRecipe",
          parentGuid: "workspace",
          name: "FromTemplate",
          properties: {
            BaseLayer: [{ Name: "FireRise_A", NiagaraSystem: FIRE_RISE_PATH }],
          },
        },
      ],
    });

    const [source] = (parsed.items[0].properties as Record<string, unknown>).BaseLayer as Record<string, unknown>[];
    expect(source.NiagaraSystem).toBe(FIRE_RISE_PATH);
  });

  test("rejects a VFXRecipe source that does not belong to the layer", () => {
    expect(() =>
      parseArgs({
        items: [
          {
            class: "VFXRecipe",
            parentGuid: "workspace",
            name: "WrongLayer",
            properties: {
              DetailLayer: [{ Name: "FireRise_A", NiagaraSystem: FIRE_RISE_PATH }],
            },
          },
        ],
      }),
    ).toThrow(/class=VFXRecipe/);
  });

  test("accepts template payloads: Alpha keypoints kept, top-level LoopDuration stripped", () => {
    const parsed = parseArgs({
      items: [
        {
          class: "VFXRecipe",
          parentGuid: "workspace",
          name: "AcidBurst",
          properties: {
            AutoActivate: true,
            InfiniteLoop: false,
            LoopCount: 1,
            LoopDuration: 2,
            BaseLayer: [
              {
                Name: "LiquidFlash_A",
                NiagaraSystem:
                  "/CommonContent/VFX/Layer/0_Base/LiquidFlash_A/VFX_UGC_Base_LiquidFlash_A.VFX_UGC_Base_LiquidFlash_A",
                Position: { ObjectType: "Vector3", X: 0, Y: 0, Z: 0 },
                Color: [
                  { ObjectType: "Color3", R: 0, G: 255, B: 0, Time: 0 },
                  { ObjectType: "Color3", R: 0, G: 255, B: 0, Time: 1 },
                ],
                Alpha: [
                  { Time: 0, Value: 1 },
                  { Time: 1, Value: 1 },
                ],
                SpawnCount: 3,
                Transparency: 0,
              },
            ],
            ExtraLayer: [
              {
                Name: "LiquidScatter_R_A",
                NiagaraSystem: "LiquidScatter_R_A",
                Duration: 1,
                SpawnRate: 15,
              },
            ],
          },
        },
      ],
    });

    const properties = parsed.items[0].properties as Record<string, unknown>;
    expect(properties.LoopDuration).toBeUndefined();
    const [base] = properties.BaseLayer as Record<string, unknown>[];
    expect(base.Alpha).toEqual([
      { Time: 0, Value: 1 },
      { Time: 1, Value: 1 },
    ]);
    // LiquidScatter_R_A exists in both Base and Extra; the Extra layer expands to the Extra asset.
    const [extra] = properties.ExtraLayer as Record<string, unknown>[];
    expect(extra.NiagaraSystem).toBe(
      "/CommonContent/VFX/Layer/2_Extra/LiquidScatter_R_A/VFX_UGC_Extra_LiquidScatter_R_A.VFX_UGC_Extra_LiquidScatter_R_A",
    );
  });
});
