// @summary Shared asset thumbnail with initial-letter fallback, used by the asset gallery block and the asset picker

import { useState } from "react";
import { cn } from "../lib/cn";

export interface AssetThumbnailData {
  title: string;
  subtitle?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
}

function assetInitial(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function AssetThumbnail({ asset, className }: { asset: AssetThumbnailData; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = asset.thumbnailUrl ?? asset.previewUrl;

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-1 bg-fill-secondary text-center",
          className,
        )}
      >
        <span className="text-2xl font-semibold leading-none text-text-soft">{assetInitial(asset.title)}</span>
        {asset.subtitle ? (
          <span className="max-w-[9rem] truncate px-2 text-2xs text-muted">{asset.subtitle}</span>
        ) : null}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={asset.title}
      loading="eager"
      className={cn("h-full w-full object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}
