import type { Component, OverlayHandle, OverlayOptions } from "./types";

interface OverlayEntry {
  component: Component;
  options: OverlayOptions;
  handle: OverlayHandle;
  hidden: boolean;
}

/** Overlay stack for modal UI elements rendered on top of base content */
export class OverlayStack {
  private entries: OverlayEntry[] = [];

  /** Show an overlay, returns handle for hide/show */
  show(component: Component, options?: OverlayOptions): OverlayHandle {
    const entry: OverlayEntry = {
      component,
      options: options ?? {},
      handle: null as unknown as OverlayHandle,
      hidden: false,
    };

    const handle: OverlayHandle = {
      hide: () => {
        const idx = this.entries.indexOf(entry);
        if (idx !== -1) {
          this.entries.splice(idx, 1);
        }
      },
      isHidden: () => entry.hidden,
      setHidden: (hidden: boolean) => {
        entry.hidden = hidden;
      },
    };

    entry.handle = handle;
    this.entries.push(entry);
    return handle;
  }

  /** Hide and remove the topmost overlay */
  hideTop(): void {
    if (this.entries.length > 0) {
      this.entries.pop();
    }
  }

  /** Get all visible overlays for compositing */
  getVisible(): ReadonlyArray<{ component: Component; options: OverlayOptions }> {
    return this.entries.filter((e) => !e.hidden).map((e) => ({ component: e.component, options: e.options }));
  }

  /** Whether any overlay is visible (affects input routing) */
  hasVisible(): boolean {
    return this.entries.some((e) => !e.hidden);
  }

  /** Get the topmost visible overlay component (for input routing) */
  getTopComponent(): Component | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!this.entries[i].hidden) {
        return this.entries[i].component;
      }
    }
    return null;
  }

  /** Clear all overlays */
  clear(): void {
    this.entries = [];
  }
}
