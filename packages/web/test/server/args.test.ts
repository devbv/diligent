// @summary Verifies CLI argument parsing for web sidecar startup options
import { describe, expect, test } from "bun:test";
import { parseArgs, resolveServerVersionOverride } from "../../src/server/index";

describe("web server parseArgs", () => {
  test("parses parent pid and other startup args", () => {
    const args = parseArgs([
      "--port=0",
      "--dist-dir=/tmp/dist",
      "--cwd=/tmp/project",
      "--log-file=.diligent/logs/web.log",
      "--parent-pid=12345",
    ]);

    expect(args.port).toBe(0);
    expect(args.distDir).toBe("/tmp/dist");
    expect(args.cwd).toBe("/tmp/project");
    expect(args.logFile).toBe(".diligent/logs/web.log");
    expect(args.parentPid).toBe(12345);
  });

  test("ignores invalid parent pid", () => {
    const args = parseArgs(["--parent-pid=abc"]);
    expect(args.parentPid).toBeUndefined();
  });

  test("reads server version override from env and prefixes the release channel", () => {
    // No DILIGENT_ENV → prod channel (mirrors currentEnv()'s conservative default).
    expect(resolveServerVersionOverride({ DILIGENT_SERVER_VERSION: "1.2.3" } as NodeJS.ProcessEnv)).toBe("prod-v1.2.3");
    expect(
      resolveServerVersionOverride({ DILIGENT_SERVER_VERSION: "1.2.3", DILIGENT_ENV: "dev" } as NodeJS.ProcessEnv),
    ).toBe("dev-v1.2.3");
    expect(
      resolveServerVersionOverride({ DILIGENT_SERVER_VERSION: "1.2.3", DILIGENT_ENV: "PROD" } as NodeJS.ProcessEnv),
    ).toBe("prod-v1.2.3");
    // A version that already carries a leading "v" must not double up.
    expect(
      resolveServerVersionOverride({ DILIGENT_SERVER_VERSION: "v1.2.3", DILIGENT_ENV: "dev" } as NodeJS.ProcessEnv),
    ).toBe("dev-v1.2.3");
    // Blank/absent forwards no override so server.ts can apply its fallback.
    expect(resolveServerVersionOverride({ DILIGENT_SERVER_VERSION: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
