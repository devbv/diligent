// @summary URL/thread helpers and image utility functions used by App orchestrator

export function getThreadIdFromUrl(): string | null {
  const path = window.location.pathname.replace(/^\/+/, "");
  return path || null;
}

export function replaceThreadUrl(threadId: string): void {
  if (getThreadIdFromUrl() !== threadId) {
    window.history.replaceState(null, "", `/${threadId}`);
  }
}

export function replaceDraftUrl(): void {
  if (window.location.pathname !== "/") {
    window.history.replaceState(null, "", "/");
  }
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function extensionForImageType(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

export function normalizeImageFileName(file: File, index: number, timestamp = Date.now()): string {
  const trimmedName = file.name?.trim() ?? "";
  if (trimmedName.length > 0) return trimmedName;
  return `pasted-image-${timestamp}-${index}${extensionForImageType(file.type)}`;
}
