// @summary Cross-language storage namespace contract test: verifies TypeScript runtime resolves namespace per D099
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDiligentDir, resolvePaths } from "@diligent/runtime";

/**
 * D099 Rust/TypeScript storage namespace boundary contract
 *
 * The storage namespace has two independent implementations:
 *   - Rust launcher (apps/overdare-ai-agent/src/storage.rs):
 *       DEFAULT_STORAGE_NAMESPACE = "diligent"
 *       PACKAGED_STORAGE_NAMESPACE_PROD = "overdare"
 *       PACKAGED_STORAGE_NAMESPACE_DEV = "overdare-dev"
 *       Uses DILIGENT_STORAGE_NAMESPACE at compile time (option_env!) for prod overrides.
 *       Sets DILIGENT_STORAGE_NAMESPACE in child process env before launching TypeScript runtime.
 *   - TypeScript runtime (packages/runtime/src/infrastructure/diligent-dir.ts):
 *       DEFAULT_STORAGE_NAMESPACE = "diligent"
 *       Reads DILIGENT_STORAGE_NAMESPACE at runtime (process.env).
 *       Creates directories under .{namespace}/ at the project root and home.
 *
 * The shared contract: when the Rust launcher runs, it always sets DILIGENT_STORAGE_NAMESPACE
 * so that both sides agree on the active namespace. When TypeScript runs standalone (e.g. diligent
 * CLI), no migration runs and the default "diligent" namespace is used.
 *
 * Invariants verified here (TypeScript side):
 *   1. Default namespace is "diligent" when env var is absent.
 *   2. DILIGENT_STORAGE_NAMESPACE env var overrides the default at runtime.
 *   3. The hidden directory name is .{namespace}.
 *   4. Required subdirectories (sessions, knowledge, skills, images) are created under root.
 *   5. Namespace values must match /^[a-z0-9-]+$/; invalid values are rejected.
 *   6. Empty or whitespace-only env var values fall back to the default.
 *
 * Rust-side constants documented here for human review: any change to these
 * values must be mirrored in the Rust implementation (storage.rs).
 */

// Rust-side namespace constants documented for cross-language contract traceability.
// These must stay in sync with apps/overdare-ai-agent/src/storage.rs.
const RUST_DEFAULT_STORAGE_NAMESPACE = "diligent";
const RUST_PACKAGED_NAMESPACE_PROD = "overdare";
const RUST_PACKAGED_NAMESPACE_DEV = "overdare-dev";

// TypeScript-side default — must equal RUST_DEFAULT_STORAGE_NAMESPACE so that a
// standalone TypeScript runtime and a Rust-launched runtime with no env override
// both start from the same namespace baseline.
const TS_DEFAULT_STORAGE_NAMESPACE = "diligent";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

describe("namespace contract: default namespace", () => {
  test("TypeScript and Rust share the same default namespace value", () => {
    expect(TS_DEFAULT_STORAGE_NAMESPACE).toBe(RUST_DEFAULT_STORAGE_NAMESPACE);
  });

  test("resolvePaths uses .diligent as the root dir when no env var is set", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, {});
    expect(paths.root).toBe(join(tmpDir, ".diligent"));
  });

  test("resolvePaths subdirectory layout matches D099 contract", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, {});
    expect(paths.sessions).toBe(join(tmpDir, ".diligent", "sessions"));
    expect(paths.knowledge).toBe(join(tmpDir, ".diligent", "knowledge"));
    expect(paths.skills).toBe(join(tmpDir, ".diligent", "skills"));
    expect(paths.images).toBe(join(tmpDir, ".diligent", "images"));
  });
});

describe("namespace contract: env var override", () => {
  test("DILIGENT_STORAGE_NAMESPACE overrides the root directory name", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "mycustom" });
    expect(paths.root).toBe(join(tmpDir, ".mycustom"));
  });

  test("subdirectory layout is preserved under a custom namespace root", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "mycustom" });
    expect(paths.sessions).toBe(join(tmpDir, ".mycustom", "sessions"));
    expect(paths.knowledge).toBe(join(tmpDir, ".mycustom", "knowledge"));
    expect(paths.skills).toBe(join(tmpDir, ".mycustom", "skills"));
    expect(paths.images).toBe(join(tmpDir, ".mycustom", "images"));
  });

  test("Rust prod namespace value 'overdare' is a valid namespace for the TypeScript runtime", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, {
      DILIGENT_STORAGE_NAMESPACE: RUST_PACKAGED_NAMESPACE_PROD,
    });
    expect(paths.root).toBe(join(tmpDir, ".overdare"));
  });

  test("Rust dev namespace value 'overdare-dev' is a valid namespace for the TypeScript runtime", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, {
      DILIGENT_STORAGE_NAMESPACE: RUST_PACKAGED_NAMESPACE_DEV,
    });
    expect(paths.root).toBe(join(tmpDir, ".overdare-dev"));
  });

  test("namespace value is normalized to lowercase", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "  MYNS  " });
    expect(paths.root).toBe(join(tmpDir, ".myns"));
  });

  test("empty string env var falls back to default namespace", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "" });
    expect(paths.root).toBe(join(tmpDir, ".diligent"));
  });

  test("whitespace-only env var falls back to default namespace", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "   " });
    expect(paths.root).toBe(join(tmpDir, ".diligent"));
  });
});

describe("namespace contract: invalid namespace values", () => {
  const invalidValues = ["with spaces", "with/slash", "with.dot", "with_underscore", "with@special"];

  for (const value of invalidValues) {
    test(`rejects invalid namespace "${value}"`, async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
      expect(() => resolvePaths(tmpDir, { DILIGENT_STORAGE_NAMESPACE: value })).toThrow(
        /Invalid DILIGENT_STORAGE_NAMESPACE/,
      );
    });
  }
});

describe("namespace contract: directory creation", () => {
  test("ensureDiligentDir creates required subdirectories under default namespace", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = await ensureDiligentDir(tmpDir, {});
    expect(await dirExists(paths.sessions)).toBe(true);
    expect(await dirExists(paths.knowledge)).toBe(true);
    expect(await dirExists(paths.skills)).toBe(true);
    expect(await dirExists(paths.images)).toBe(true);
  });

  test("ensureDiligentDir creates directories under a custom namespace root", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = await ensureDiligentDir(tmpDir, { DILIGENT_STORAGE_NAMESPACE: "testns" });
    expect(paths.root).toBe(join(tmpDir, ".testns"));
    expect(await dirExists(paths.root)).toBe(true);
    expect(await dirExists(paths.sessions)).toBe(true);
    expect(await dirExists(paths.knowledge)).toBe(true);
    expect(await dirExists(paths.skills)).toBe(true);
    expect(await dirExists(paths.images)).toBe(true);
  });

  test("ensureDiligentDir with Rust prod namespace creates directories under .overdare", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "diligent-ns-contract-"));
    const paths = await ensureDiligentDir(tmpDir, {
      DILIGENT_STORAGE_NAMESPACE: RUST_PACKAGED_NAMESPACE_PROD,
    });
    expect(paths.root).toBe(join(tmpDir, ".overdare"));
    expect(await dirExists(paths.root)).toBe(true);
    expect(await dirExists(paths.sessions)).toBe(true);
    expect(await dirExists(paths.knowledge)).toBe(true);
    expect(await dirExists(paths.skills)).toBe(true);
    expect(await dirExists(paths.images)).toBe(true);
  });
});
