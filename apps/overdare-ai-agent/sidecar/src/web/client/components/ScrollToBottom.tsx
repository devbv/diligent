// @summary Fixed scroll-to-bottom button shown when user has scrolled up

interface ScrollToBottomProps {
  onClick: () => void;
}

export function ScrollToBottom({ onClick }: ScrollToBottomProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border-strong/100 bg-surface-light px-3 py-1.5 font-mono text-xs text-text shadow-panel transition hover:bg-fill-ghost-hover hover:text-text"
    >
      ↓ scroll to bottom
    </button>
  );
}
