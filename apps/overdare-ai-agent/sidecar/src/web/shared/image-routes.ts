// @summary Shared helpers for mapping persisted local images to browser-safe Web routes

export const WEB_IMAGE_ROUTE_PREFIX = "/_diligent/image/";

const HIDDEN_STORAGE_IMAGES_PATTERN = /[\\/]\.[^\\/]+[\\/]images[\\/]/g;

export function toWebImageUrl(localPath: string): string {
  const relativePath = extractDiligentImageRelativePath(localPath);
  if (!relativePath) {
    return localPath;
  }

  const encodedPath = relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${WEB_IMAGE_ROUTE_PREFIX}${encodedPath}`;
}

export function decodeWebImageRelativePath(pathname: string): string | null {
  if (!pathname.startsWith(WEB_IMAGE_ROUTE_PREFIX)) {
    return null;
  }

  const encodedPath = pathname.slice(WEB_IMAGE_ROUTE_PREFIX.length);
  if (encodedPath.length === 0) {
    return null;
  }

  try {
    const segments = encodedPath
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(decodeURIComponent);
    return segments.length > 0 ? segments.join("/") : null;
  } catch {
    return null;
  }
}

function extractDiligentImageRelativePath(localPath: string): string | null {
  const matches = Array.from(localPath.matchAll(HIDDEN_STORAGE_IMAGES_PATTERN));
  const match = matches.at(-1);
  if (!match || typeof match.index !== "number") {
    return null;
  }

  const relativePath = localPath.slice(match.index + match[0].length);
  const normalizedPath = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join("/");

  return normalizedPath.length > 0 ? normalizedPath : null;
}
