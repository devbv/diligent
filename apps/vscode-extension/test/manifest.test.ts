import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("VS Code extension package", () => {
  test("manifest declares the dedicated Diligent container and simplified thread actions", async () => {
    const manifestPath = path.resolve(import.meta.dir, "../package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

    expect(manifest.activationEvents).toContain("onView:diligent.threads");
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe("diligent");
    expect(manifest.contributes.views.diligent).toEqual([{ id: "diligent.threads", name: "Threads" }]);
    expect(
      manifest.contributes.commands.find((command: { command: string }) => command.command === "diligent.newThread")
        ?.title,
    ).toBe("Diligent: Start New Thread");
    expect(
      manifest.contributes.commands.some(
        (command: { command: string }) => command.command === "diligent.openConversation",
      ),
    ).toBe(true);
    expect(manifest.contributes.menus["view/item/context"]).toBeUndefined();
  });
});
