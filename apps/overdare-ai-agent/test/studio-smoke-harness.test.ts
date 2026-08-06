// @summary Test isolation and diagnostics helpers for the Windows Studio smoke runner.

import { describe, expect, test } from "bun:test";
import {
  createIsolatedEnv,
  createSmokeAgentConfig,
  isLoadedProjectTree,
  withStageTimeout,
} from "./studio-smoke/harness-support";
import { redactStudioDiagnostic } from "./studio-smoke/run";

describe("Studio smoke harness", () => {
  test("replaces PATH and user state without forwarding credentials", () => {
    const env = createIsolatedEnv(
      {
        SystemRoot: String.raw`C:\Windows`,
        PATH: String.raw`C:\Users\developer\bin`,
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
      },
      {
        home: String.raw`C:\run\user`,
        appData: String.raw`C:\run\user\AppData\Roaming`,
        localAppData: String.raw`C:\run\user\AppData\Local`,
        temp: String.raw`C:\run\temp`,
      },
      String.raw`C:\run\studio\Studio.exe`,
    );
    expect(env.PATH).toBe(String.raw`C:\run\studio;C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0`);
    expect(env.USERPROFILE).toBe(String.raw`C:\run\user`);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("requires a non-empty project tree and labels timeouts", async () => {
    expect(isLoadedProjectTree({ level: [{ guid: "root" }] })).toBe(true);
    expect(isLoadedProjectTree({ level: [] })).toBe(false);
    await expect(
      withStageTimeout("project-ready", 5, async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      }),
    ).rejects.toThrow("[project-ready] timed out");
  });

  test("redacts Studio authentication material before preserving diagnostics", () => {
    expect(
      redactStudioDiagnostic(
        '-AUTH_PASSWORD=exchange-code {"refresh_token":"secret","Authorization":"Bearer opaque"} access_token=query-secret OverdareLogintoken=credential-secret Authorization: Bearer opaque-token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
      ),
    ).toBe(
      '-AUTH_PASSWORD=[REDACTED] {"refresh_token":"[REDACTED]","Authorization":"[REDACTED]"} access_token=[REDACTED] OverdareLogintoken=[REDACTED] Authorization: Bearer [REDACTED] [REDACTED_JWT]',
    );
  });

  test("disables agent runtime updates inside the disposable profile", () => {
    expect(JSON.parse(createSmokeAgentConfig())).toEqual({ updateMode: "disabled" });
  });
});
