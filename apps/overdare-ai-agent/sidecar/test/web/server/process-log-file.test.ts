// @summary Verifies process log mirroring creates log files lazily on first write
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableProcessLogFile } from "../../../src/web/server/index";

async function waitFor(condition: () => boolean, timeoutMs: number = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("does not create the log file until first stdout/stderr write", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "diligent-web-log-lazy-"));
  const logRelativePath = ".diligent/logs/lazy.log";
  const logAbsolutePath = join(baseDir, ".diligent", "logs", "lazy.log");

  const cleanup = enableProcessLogFile(logRelativePath, baseDir);
  try {
    expect(existsSync(logAbsolutePath)).toBe(false);

    const probe = `[process-log-lazy-test] ${crypto.randomUUID()}\n`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(probe, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await waitFor(() => existsSync(logAbsolutePath));
    const content = await readFile(logAbsolutePath, "utf8");
    expect(content).toContain(probe.trim());
  } finally {
    cleanup();
    await rm(baseDir, { recursive: true, force: true });
  }
});
