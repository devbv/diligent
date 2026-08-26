import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vfxLayerSourceNames } from "../../src/tools/studiorpc/methods/instance.params";

const REF_DIR = join(import.meta.dir, "../../../bootstrap/skills/vfx-recipe/references");
const LAYER_TO_NAMES: Record<string, readonly string[]> = {
  "0_Base": vfxLayerSourceNames.Base,
  "1_Detail": vfxLayerSourceNames.Detail,
  "2_Extra": vfxLayerSourceNames.Extra,
};

describe("vfx-recipe bundled references", () => {
  test("presets.md has the full catalog in grep format", () => {
    const rows = readFileSync(join(REF_DIR, "presets.md"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("| VFX_"));
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) {
      // | Resource | DisplayName | Category | Subcategory | Genre | Keywords |
      const cells = row.split("|").map((c) => c.trim());
      expect(cells[1]).toMatch(/^VFX_/);
      expect(cells.length).toBe(8); // leading/trailing empty + 6 columns
    }
  });

  test("every template NiagaraSystem path uses a source the upsert schema accepts", () => {
    const templateDir = join(REF_DIR, "templates");
    const files = readdirSync(templateDir).filter((f) => f.startsWith("combo_"));
    expect(files.length).toBe(7);
    for (const file of files) {
      const content = readFileSync(join(templateDir, file), "utf8");
      const refs = [...content.matchAll(/\/CommonContent\/VFX\/Layer\/(0_Base|1_Detail|2_Extra)\/([A-Za-z0-9_]+)\//g)];
      expect(refs.length).toBeGreaterThan(0);
      for (const [, layer, source] of refs) {
        expect(LAYER_TO_NAMES[layer]).toContain(source);
      }
    }
  });

  test("00_INDEX.md lists exactly the bundled template files", () => {
    const templateDir = join(REF_DIR, "templates");
    const files = readdirSync(templateDir)
      .filter((f) => f.startsWith("combo_"))
      .sort();
    const index = readFileSync(join(templateDir, "00_INDEX.md"), "utf8");
    const listed = [...index.matchAll(/\*\*(combo_[^*]+)\*\*/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(files);
  });
});
