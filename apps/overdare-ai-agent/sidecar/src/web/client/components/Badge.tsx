// @summary Compact status badge component for mode, connection, and thread status indicators
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Badge(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex items-center rounded-full border border-border/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
        props.className,
      )}
    />
  );
}
