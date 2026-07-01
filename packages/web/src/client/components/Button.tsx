// @summary Variant-based button component for Web CLI actions and modal decisions
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { focusRingClasses } from "./ui-styles";

type Intent = "primary" | "info" | "danger" | "ghost";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: Intent;
  size?: Size;
}

const intentClasses: Record<Intent, string> = {
  primary: "border border-transparent bg-fill-primary text-text hover:bg-fill-primary-hover",
  info: "border border-transparent bg-fill-info text-text hover:bg-fill-info-hover focus-visible:ring-info",
  danger: "border border-transparent bg-danger text-text hover:opacity-90",
  ghost:
    "border border-border/100 bg-fill-secondary text-text hover:border-border-strong/100 hover:bg-fill-ghost-hover",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
};

export function Button({ className, intent = "primary", size = "md", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        focusRingClasses,
        intentClasses[intent],
        sizeClasses[size],
        className,
      )}
    />
  );
}
