// @summary Hook for anchoring fixed portal popovers to an in-flow trigger element

import { type RefObject, useEffect, useState } from "react";

interface AnchoredPortalPosition {
  left: number;
  bottom: number;
}

interface UseAnchoredPortalOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popupRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  offset?: number;
}

export function useAnchoredPortal({
  open,
  anchorRef,
  popupRef,
  onClose,
  offset = 8,
}: UseAnchoredPortalOptions): AnchoredPortalPosition | null {
  const [position, setPosition] = useState<AnchoredPortalPosition | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      if (!anchorRect) return;

      setPosition({
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + offset,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, offset, open]);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [anchorRef, onClose, open, popupRef]);

  return position;
}
