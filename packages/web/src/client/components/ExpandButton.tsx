// @summary Reusable show-more/less toggle button for expandable content blocks

import { microLabelClasses, subtleDividerClasses } from "./ui-styles";

interface ExpandButtonProps {
  expanded: boolean;
  onToggle: () => void;
  detail?: string;
}

export function ExpandButton({ expanded, onToggle, detail }: ExpandButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full border-t py-1.5 text-center transition hover:text-text ${subtleDividerClasses} ${microLabelClasses}`}
    >
      {expanded ? "Show less ▴" : `Show more ▾${detail ? ` (${detail})` : ""}`}
    </button>
  );
}
