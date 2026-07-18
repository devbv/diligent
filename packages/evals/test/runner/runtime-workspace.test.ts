// @summary Tests runtime eval workspace confinement, manifests, diffs, and cleanup guards

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspace,
  removeTemporaryRoot,
  resolveWorkspacePath,
  validateTemporaryRoot,
  workspaceDiff,
} from "../../src/runner/runtime-workspace";

describe("runtime workspace", () => {
  test("hashes a stable relative manifest and reports changed byte budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
      const initial = await captureWorkspace(root);
      await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n");
      const final = await captureWorkspace(root);
      expect(initial.entries.find((entry) => entry.path === "src/value.ts")?.sha256).not.toBe(
        final.entries.find((entry) => entry.path === "src/value.ts")?.sha256,
      );
      expect(workspaceDiff(initial, final)).toEqual({ changedFiles: ["src/value.ts"], changedBytes: 24 });
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("rejects Unix, Windows, UNC, and traversal escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    try {
      for (const candidate of ["/etc/passwd", "C:\\Windows\\system.ini", "\\\\server\\share", "../escape"]) {
        expect(() => resolveWorkspacePath(root, candidate)).toThrow("workspace_escape");
      }
      expect(resolveWorkspacePath(root, "src\\safe.ts")).toBe(join(root, "src", "safe.ts"));
      if (process.platform === "darwin" && root.startsWith("/var/")) {
        expect(resolveWorkspacePath(root, `/private${root}/src/safe.ts`)).toBe(`/private${root}/src/safe.ts`);
      }
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("records symlinks so fixture validation can reject them", async () => {
    const root = await mkdtemp(join(tmpdir(), "diligent-runtime-eval-"));
    try {
      await writeFile(join(root, "target"), "value");
      await symlink("target", join(root, "link"));
      expect((await captureWorkspace(root)).entries.find((entry) => entry.path === "link")?.kind).toBe("symlink");
    } finally {
      await removeTemporaryRoot(root);
    }
  });

  test("refuses broad cleanup roots", () => {
    expect(() => validateTemporaryRoot(process.cwd())).toThrow("Refusing broad");
  });
});
