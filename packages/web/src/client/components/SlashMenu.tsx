// @summary Slash command autocomplete dropdown rendered above the chat input

import { type CSSProperties, useEffect, useRef } from "react";
import type { SlashCommand } from "../lib/slash-commands";
import { menuPanelClasses } from "./ui-styles";

interface SlashMenuProps {
  /** Filtered commands to display */
  commands: SlashCommand[];
  /** Currently highlighted index */
  selectedIndex: number;
  /** Called when user clicks a command */
  onSelect: (command: SlashCommand) => void;
  className?: string;
  style?: CSSProperties;
}

export function SlashMenu({ commands, selectedIndex, onSelect, className, style }: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Scroll selected item into view
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex drives scroll-into-view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className={className ?? `absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden ${menuPanelClasses}`}
      style={style}
    >
      <div className="max-h-60 overflow-y-auto py-1">
        {commands.map((cmd, i) => {
          const isSelected = i === selectedIndex;

          return (
            <button
              key={cmd.name}
              ref={isSelected ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(cmd)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition ${
                isSelected ? "bg-fill-active text-text" : "text-muted hover:bg-fill-ghost-hover hover:text-text"
              }`}
            >
              <span className="shrink-0 font-mono font-medium text-text">/{cmd.name}</span>
              <span className="min-w-0 truncate text-muted">{cmd.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
