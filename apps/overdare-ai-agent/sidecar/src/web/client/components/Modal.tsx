// @summary Accessible modal wrapper for approval and request-user-input prompts
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { elevatedCardClasses } from "./ui-styles";

interface ModalProps {
  title: string;
  description?: string;
  children: ReactNode;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function isButtonLikeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  if (tagName === "BUTTON" || tagName === "A") return true;
  const role = target.getAttribute("role");
  return role === "button" || role === "link";
}

export function Modal({ title, description, children, onConfirm, onCancel }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    if (event.key === "Escape" && onCancel) {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void onCancel();
      return;
    }

    if (event.key === "Enter" && onConfirm) {
      if (isEditableTarget(event.target) || isButtonLikeTarget(event.target)) return;
      event.preventDefault();
      void onConfirm();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-4" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`w-full max-w-lg p-5 ${elevatedCardClasses}`}
      >
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
