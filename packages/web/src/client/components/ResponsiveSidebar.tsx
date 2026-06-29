// @summary Responsive sidebar frame that behaves as a desktop rail and mobile drawer
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface ResponsiveSidebarProps {
  open: boolean;
  onRequestClose: () => void;
  children: ReactNode;
  id?: string;
}

export function ResponsiveSidebar({ open, onRequestClose, children, id = "app-sidebar" }: ResponsiveSidebarProps) {
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-40 bg-overlay/45 transition-opacity md:hidden"
          onClick={onRequestClose}
        />
      ) : null}
      <aside
        id={id}
        aria-label="Conversations"
        aria-hidden={open ? undefined : true}
        inert={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-50 h-full w-[min(20rem,calc(100vw-2rem))] shrink-0 overflow-hidden border-r border-border/100 bg-surface-default transition-transform duration-200 ease-out md:relative md:inset-auto md:z-auto md:h-full md:transition-[width]",
          open ? "translate-x-0 md:w-[280px]" : "-translate-x-full md:w-0 md:translate-x-0 md:border-r-0",
        )}
      >
        <div className="h-full w-full">{children}</div>
      </aside>
    </>
  );
}
