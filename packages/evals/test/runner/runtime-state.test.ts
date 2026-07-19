// @summary Tests deterministic root and nested runtime-state classification, diffs, and mutation policy

import { describe, expect, test } from "bun:test";
import {
  captureRuntimeState,
  checkRuntimeStatePolicy,
  classifyRuntimeState,
  projectSnapshotWithoutRuntimeState,
} from "../../src/runner/runtime-state";
import type { RuntimeWorldSnapshot } from "../../src/runtime-task";

const file = (path: string, sha256 = path): RuntimeWorldSnapshot["entries"][number] => ({
  path,
  kind: "file",
  size: 1,
  sha256,
});
const directory = (path: string): RuntimeWorldSnapshot["entries"][number] => ({
  path,
  kind: "directory",
  size: 0,
});

describe("runtime state evidence", () => {
  test("classifies root and nested runtime layouts with deterministic categories", () => {
    const snapshot = {
      entries: [
        file("nested/.diligent/skills/demo/SKILL.md"),
        file(".diligent/sessions/blobs/hash.bin"),
        file(".diligent/sessions/thread.jsonl"),
        directory(".diligent/knowledge"),
        file(".diligent/images/draft/image.png"),
        file(".diligent/.gitignore"),
        file(".diligent/cache/value"),
        file("project.txt"),
      ],
    } satisfies RuntimeWorldSnapshot;

    expect(classifyRuntimeState(snapshot, [".diligent", "nested/.diligent"])).toEqual([
      expect.objectContaining({ path: ".diligent/.gitignore", category: "infrastructure" }),
      expect.objectContaining({ path: ".diligent/cache/value", category: "other" }),
      expect.objectContaining({ path: ".diligent/images/draft/image.png", category: "image_sidecars" }),
      expect.objectContaining({ path: ".diligent/knowledge", category: "infrastructure" }),
      expect.objectContaining({ path: ".diligent/sessions/blobs/hash.bin", category: "image_sidecars" }),
      expect.objectContaining({ path: ".diligent/sessions/thread.jsonl", category: "sessions" }),
      expect.objectContaining({ path: "nested/.diligent/skills/demo/SKILL.md", category: "skills" }),
    ]);
  });

  test("diffs paths without contents and removes only classified state from project evidence", () => {
    const initial = { entries: [file("src/a.ts", "old"), file(".diligent/knowledge/knowledge.jsonl", "old")] };
    const final = {
      entries: [
        file("src/a.ts", "new"),
        file(".diligent/knowledge/knowledge.jsonl", "new"),
        file("nested/.diligent/skills/new/SKILL.md"),
      ],
    };
    const evidence = captureRuntimeState(initial, final, [".diligent", "nested/.diligent"]);

    expect(evidence.diff).toEqual([
      { path: ".diligent/knowledge/knowledge.jsonl", category: "knowledge", change: "modified" },
      { path: "nested/.diligent/skills/new/SKILL.md", category: "skills", change: "added" },
    ]);
    expect(Object.keys(evidence.diff[0]!)).toEqual(["path", "category", "change"]);
    expect(projectSnapshotWithoutRuntimeState(final, [".diligent", "nested/.diligent"]).entries).toEqual([
      file("src/a.ts", "new"),
    ]);
  });

  test("rejects other and skills mutations and a missing required category", () => {
    const evidence = captureRuntimeState(
      { entries: [] },
      { entries: [file(".diligent/cache/x"), file(".diligent/skills/demo/SKILL.md")] },
      [".diligent"],
    );
    const failures = checkRuntimeStatePolicy(
      evidence,
      { allowedMutations: ["infrastructure", "sessions"], requiredMutations: ["knowledge"] },
      true,
    );
    expect(failures.map((failure) => failure.code)).toEqual([
      "runtime_contract.undeclared_state_mutation",
      "runtime_contract.required_state_mutation_missing",
    ]);
  });

  test("allows and requires declared knowledge and image changes", () => {
    const evidence = captureRuntimeState(
      { entries: [] },
      {
        entries: [file(".diligent/knowledge/knowledge.jsonl"), file("nested/.diligent/sessions/blobs/hash.bin")],
      },
      [".diligent", "nested/.diligent"],
    );
    expect(
      checkRuntimeStatePolicy(
        evidence,
        {
          allowedMutations: ["infrastructure", "sessions", "knowledge", "image_sidecars"],
          requiredMutations: ["knowledge", "image_sidecars"],
        },
        true,
      ),
    ).toEqual([]);
  });
});
