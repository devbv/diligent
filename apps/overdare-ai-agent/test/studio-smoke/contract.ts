// @summary Parse and validate the external contract for the OVERDARE Studio smoke harness.

import { resolve, win32 } from "node:path";
import type { S3StudioSource } from "./s3-source";

const configuredRepoRoot = process.env.OVERDARE_SMOKE_REPO_ROOT?.trim();
const REPO_ROOT = configuredRepoRoot ? resolve(configuredRepoRoot) : resolve(import.meta.dir, "../../../..");

export const STUDIO_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface SmokeContract {
  source: { kind: "url"; url: string } | ({ kind: "s3" } & S3StudioSource);
  studioSha256?: string;
  studioExeRelativePath: string;
  studioArgs: string[];
  studioRpcPort: number;
  artifactRoot: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 127
  );
}

export function isAllowedStudioDownloadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isPrivateIpv4(url.hostname));
}

export function readSmokeContract(env: NodeJS.ProcessEnv = process.env): SmokeContract {
  const studioUrl = env.OVERDARE_STUDIO_URL?.trim();
  const hasS3Source = ["OVERDARE_STUDIO_S3_BUCKET", "OVERDARE_STUDIO_S3_REGION", "OVERDARE_STUDIO_S3_PREFIX"].some(
    (name) => Boolean(env[name]?.trim()),
  );
  if (studioUrl && hasS3Source) {
    throw new Error("Configure either OVERDARE_STUDIO_URL or the OVERDARE_STUDIO_S3_* source, not both");
  }

  let source: SmokeContract["source"];
  if (studioUrl) {
    if (!isAllowedStudioDownloadUrl(studioUrl)) {
      throw new Error("OVERDARE_STUDIO_URL must use HTTPS or use a private IPv4 address over HTTP");
    }
    source = { kind: "url", url: studioUrl };
  } else if (hasS3Source) {
    source = {
      kind: "s3",
      bucket: required(env, "OVERDARE_STUDIO_S3_BUCKET"),
      region: required(env, "OVERDARE_STUDIO_S3_REGION"),
      prefix: required(env, "OVERDARE_STUDIO_S3_PREFIX"),
      credentials: {
        accessKeyId: required(env, "AWS_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "AWS_SECRET_ACCESS_KEY"),
        ...(env.AWS_SESSION_TOKEN?.trim() ? { sessionToken: env.AWS_SESSION_TOKEN.trim() } : {}),
      },
    };
  } else {
    throw new Error("Configure OVERDARE_STUDIO_URL or OVERDARE_STUDIO_S3_BUCKET/REGION/PREFIX");
  }

  const studioSha256 = env.OVERDARE_STUDIO_SHA256?.trim().toLowerCase();
  if (source.kind === "url" && !studioSha256) {
    throw new Error("Missing required environment variable: OVERDARE_STUDIO_SHA256");
  }
  if (studioSha256 && !/^[a-f0-9]{64}$/.test(studioSha256)) {
    throw new Error("OVERDARE_STUDIO_SHA256 must be 64 hexadecimal characters");
  }
  const studioExeRelativePath = required(env, "OVERDARE_STUDIO_EXE_RELATIVE_PATH");
  if (win32.isAbsolute(studioExeRelativePath) || studioExeRelativePath.split(/[\\/]+/).includes("..")) {
    throw new Error("OVERDARE_STUDIO_EXE_RELATIVE_PATH must stay inside the Studio archive");
  }

  let studioArgs: unknown;
  try {
    studioArgs = JSON.parse(required(env, "OVERDARE_STUDIO_ARGS_JSON"));
  } catch (error) {
    throw new Error(`OVERDARE_STUDIO_ARGS_JSON must be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(studioArgs) || studioArgs.some((value) => typeof value !== "string")) {
    throw new Error("OVERDARE_STUDIO_ARGS_JSON must be a JSON array of argument strings");
  }
  const studioRpcPort = Number(env.OVERDARE_STUDIO_RPC_PORT?.trim() || "13377");
  if (!Number.isInteger(studioRpcPort) || studioRpcPort < 1 || studioRpcPort > 65_535) {
    throw new Error("OVERDARE_STUDIO_RPC_PORT must be an integer between 1 and 65535");
  }

  return {
    source,
    studioSha256,
    studioExeRelativePath,
    studioArgs,
    studioRpcPort,
    artifactRoot: resolve(REPO_ROOT, env.OVERDARE_STUDIO_ARTIFACT_DIR?.trim() || "artifacts/studio-smoke"),
  };
}

export function renderStudioArgs(
  template: string[],
  values: { projectDir: string; projectMap: string; rpcPort: number; logDir: string; userDataDir: string },
): string[] {
  return template.map((argument) =>
    argument
      .replaceAll("{projectDir}", values.projectDir)
      .replaceAll("{projectMap}", values.projectMap)
      .replaceAll("{rpcPort}", String(values.rpcPort))
      .replaceAll("{logDir}", values.logDir)
      .replaceAll("{userDataDir}", values.userDataDir),
  );
}

export function createStudioLaunchArgs(
  extraArgs: string[],
  values: { projectDir: string; projectMap: string; rpcPort: number; logDir: string; userDataDir: string },
): string[] {
  return [
    `-OpenMap=${values.projectMap}`,
    `-ABSLOG=${win32.join(values.userDataDir, "studio.log")}`,
    ...renderStudioArgs(extraArgs, values),
  ];
}
