// @summary Colored status indicator dot with optional pulse animation

interface StatusDotProps {
  color: "success" | "accent" | "danger";
  pulse?: boolean;
  size?: "sm" | "md";
}

const COLOR_CLASSES: Record<StatusDotProps["color"], string> = {
  success: "bg-success",
  accent: "bg-accent",
  danger: "bg-danger",
};

const SIZE_CLASSES: Record<NonNullable<StatusDotProps["size"]>, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
};

export function StatusDot({ color, pulse = false, size = "sm" }: StatusDotProps) {
  return (
    <span
      className={`shrink-0 rounded-full ${SIZE_CLASSES[size]} ${COLOR_CLASSES[color]}${pulse ? " animate-pulse" : ""}`}
    />
  );
}
