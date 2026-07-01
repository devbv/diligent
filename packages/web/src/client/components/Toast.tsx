// @summary Fixed-position toast notification with bounded wrapping for long messages

import type { ToastState } from "../lib/thread-store";

interface ToastProps {
  toast: ToastState;
  onDismiss?: () => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const isError = toast.kind === "error";
  const toneClass = isError
    ? "border-danger/40 bg-surface-default text-danger"
    : "border-accent/40 bg-surface-default text-accent";

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`toast-animate fixed right-4 top-20 z-50 w-toast-mobile rounded-md border px-3 py-2 text-sm leading-relaxed shadow-panel sm:w-toast ${toneClass} ${
        toast.fatal ? "cursor-pointer" : ""
      }`}
      onClick={toast.fatal ? onDismiss : undefined}
    >
      <div className="max-h-toast overflow-y-auto whitespace-pre-wrap break-words">
        {toast.message}
        {toast.fatal && <span className="ml-2 opacity-50">×</span>}
      </div>
    </div>
  );
}
