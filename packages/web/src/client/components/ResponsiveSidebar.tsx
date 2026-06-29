// @summary Responsive sidebar frame that behaves as a desktop rail and mobile full-screen overlay
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface ResponsiveSidebarProps {
  open: boolean;
  children: ReactNode;
  id?: string;
}

export function ResponsiveSidebar({ open, children, id = "app-sidebar" }: ResponsiveSidebarProps) {
  return (
    <aside
      id={id}
      aria-label="Conversations"
      aria-hidden={open ? undefined : true}
      inert={!open}
      className={cn(
        "fixed inset-0 z-50 h-full w-screen shrink-0 overflow-hidden bg-surface-default sm:relative sm:inset-auto sm:z-auto sm:h-full sm:border-r sm:border-border/100",
        open
          ? "translate-x-0 transition-transform duration-200 ease-out sm:w-[280px] sm:transition-[width]"
          : "-translate-x-full transition-none sm:w-0 sm:translate-x-0 sm:border-r-0",
      )}
    >
      <div className="h-full w-full">{children}</div>
    </aside>
  );
}
