// @summary Select the newest Windows Release/Shipping Studio archive from object-store metadata.

export interface StudioReleaseObject {
  key: string;
  lastModified: string;
  size?: number;
}

const WINDOWS_RELEASE_PREFIX = "Sandbox/Windows/";
const WINDOWS_RELEASE_SUFFIX = "_Sandbox_Shipping.zip";

function releaseTimestamp(object: StudioReleaseObject, prefix: string): number | undefined {
  if (!object.key.startsWith(prefix)) return undefined;
  const filename = object.key.slice(prefix.length);
  if (!filename.includes("-release-") || !filename.endsWith(WINDOWS_RELEASE_SUFFIX)) return undefined;
  if (object.size === 0) return undefined;
  const timestamp = Date.parse(object.lastModified);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function selectLatestWindowsStudioRelease(
  objects: readonly StudioReleaseObject[],
  prefix = WINDOWS_RELEASE_PREFIX,
): StudioReleaseObject {
  const candidates = objects
    .map((object) => ({ object, timestamp: releaseTimestamp(object, prefix) }))
    .filter((candidate): candidate is { object: StudioReleaseObject; timestamp: number } =>
      Number.isFinite(candidate.timestamp),
    )
    .sort((left, right) => right.timestamp - left.timestamp || right.object.key.localeCompare(left.object.key));

  const latest = candidates[0]?.object;
  if (!latest) {
    throw new Error("No Windows Release/Shipping Studio archive was found");
  }
  return latest;
}
