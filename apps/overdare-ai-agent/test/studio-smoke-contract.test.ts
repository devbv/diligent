// @summary Test Studio smoke contract parsing and launch argument construction.

import { describe, expect, test } from "bun:test";
import { createStudioLaunchArgs, readSmokeContract, STUDIO_DOWNLOAD_TIMEOUT_MS } from "./studio-smoke/contract";

const VALID_ENV: NodeJS.ProcessEnv = {
  OVERDARE_STUDIO_URL: "https://s3.example.test/studio.zip?signature=short-lived",
  OVERDARE_STUDIO_SHA256: "a".repeat(64),
  OVERDARE_STUDIO_EXE_RELATIVE_PATH: String.raw`Studio\OVERDAREStudio.exe`,
  OVERDARE_STUDIO_ARGS_JSON: JSON.stringify(["--log-dir={logDir}"]),
};

const VALID_S3_ENV: NodeJS.ProcessEnv = {
  OVERDARE_STUDIO_S3_BUCKET: "ovdr-build-binary",
  OVERDARE_STUDIO_S3_REGION: "ap-northeast-2",
  OVERDARE_STUDIO_S3_PREFIX: "Sandbox/Windows/",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  OVERDARE_STUDIO_EXE_RELATIVE_PATH: "Sandbox.exe",
  OVERDARE_STUDIO_ARGS_JSON: VALID_ENV.OVERDARE_STUDIO_ARGS_JSON,
};

describe("Studio smoke contract", () => {
  test("allows large Studio archives up to thirty minutes to download", () => {
    expect(STUDIO_DOWNLOAD_TIMEOUT_MS).toBe(30 * 60_000);
  });

  test("validates the explicit Studio launch contract", () => {
    const contract = readSmokeContract(VALID_ENV);
    expect(contract.source.kind).toBe("url");
    expect(contract.studioSha256).toBe("a".repeat(64));
    expect(contract.studioRpcPort).toBe(13377);
    const privateUrlContract = readSmokeContract({
      ...VALID_ENV,
      OVERDARE_STUDIO_URL: "http://10.31.55.107:9000/bucket/studio.zip?signature=short-lived",
    });
    expect(privateUrlContract.source.kind === "url" ? privateUrlContract.source.url : "").toStartWith(
      "http://10.31.55.107:9000/",
    );
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_URL: "http://downloads.example.test/studio.zip",
      }),
    ).toThrow("HTTPS or use a private IPv4");
    expect(
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_ARGS_JSON: "[]",
      }).studioArgs,
    ).toEqual([]);
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_ARGS_JSON: JSON.stringify({ project: "{projectDir}" }),
      }),
    ).toThrow("JSON array");
    expect(() =>
      readSmokeContract({
        ...VALID_ENV,
        OVERDARE_STUDIO_RPC_PORT: "not-a-port",
      }),
    ).toThrow("OVERDARE_STUDIO_RPC_PORT");
  });

  test("accepts an AWS S3 source with temporary credentials", () => {
    const contract = readSmokeContract({
      ...VALID_S3_ENV,
      AWS_SESSION_TOKEN: "temporary-session-token",
    });

    expect(contract.source).toEqual({
      kind: "s3",
      bucket: "ovdr-build-binary",
      region: "ap-northeast-2",
      prefix: "Sandbox/Windows/",
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        sessionToken: "temporary-session-token",
      },
    });
    expect(contract.studioSha256).toBeUndefined();
  });

  test("requires complete AWS credentials for an S3 source", () => {
    expect(() =>
      readSmokeContract({
        ...VALID_S3_ENV,
        AWS_SECRET_ACCESS_KEY: undefined,
      }),
    ).toThrow("AWS_SECRET_ACCESS_KEY");
  });

  test("always opens the staged Studio map before applying extra arguments", () => {
    expect(
      createStudioLaunchArgs(JSON.parse(VALID_ENV.OVERDARE_STUDIO_ARGS_JSON!), {
        projectDir: String.raw`C:\run\project`,
        projectMap: String.raw`C:\run\project\project.umap`,
        rpcPort: 43123,
        logDir: String.raw`C:\run\logs`,
        userDataDir: String.raw`C:\run\user-data`,
      }),
    ).toEqual([
      String.raw`-OpenMap=C:\run\project\project.umap`,
      String.raw`-ABSLOG=C:\run\user-data\studio.log`,
      String.raw`--log-dir=C:\run\logs`,
    ]);
  });
});
