// @summary Custom styled dropdown select with grouped options and outside-click close

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  composerSelectTriggerClasses,
  menuItemClasses,
  menuPanelClasses,
  selectedMenuItemClasses,
  selectTriggerBaseClasses,
  selectTriggerDefaultClasses,
} from "./ui-styles";

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

interface SelectProps {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  triggerClassName?: string;
  triggerVariant?: "default" | "composer";
  menuClassName?: string;
  openDirection?: "up" | "down";
  disabled?: boolean;
}

interface OptionGroup {
  key: string;
  label: string | null;
  options: SelectOption[];
}

export function Select({
  ariaLabel,
  value,
  options,
  onChange,
  className,
  triggerClassName,
  triggerVariant = "default",
  menuClassName,
  openDirection = "down",
  disabled = false,
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const groupedOptions = useMemo<OptionGroup[]>(() => {
    const groups: OptionGroup[] = [];
    const indices = new Map<string, number>();

    for (const option of options) {
      const groupKey = option.group ?? "__ungrouped__";
      const index = indices.get(groupKey);
      if (index === undefined) {
        indices.set(groupKey, groups.length);
        groups.push({
          key: groupKey,
          label: option.group ?? null,
          options: [option],
        });
        continue;
      }
      groups[index].options.push(option);
    }

    return groups;
  }, [options]);

  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((open) => !open)}
        className={cn(
          selectTriggerBaseClasses,
          triggerVariant === "composer" ? composerSelectTriggerClasses : selectTriggerDefaultClasses,
          disabled && "cursor-not-allowed opacity-40",
          triggerClassName,
        )}
      >
        <span className="min-w-0 truncate text-text">{selectedOption?.label ?? value}</span>
        <span className={cn("text-2xs leading-none opacity-70 transition-transform", isOpen && "rotate-180")}>▼</span>
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className={cn(
            "absolute z-30 min-w-full overflow-hidden",
            menuPanelClasses,
            openDirection === "up" ? "bottom-full mb-1" : "top-full mt-1",
            menuClassName,
          )}
        >
          <div className="max-h-56 overflow-y-auto py-1">
            {groupedOptions.map((group) => (
              <div key={group.key}>
                {group.label ? (
                  <div className="px-2 pb-1 pt-1 text-2xs uppercase tracking-wide text-muted/80">{group.label}</div>
                ) : null}
                {group.options.map((option) => (
                  <button
                    key={`${group.key}:${option.value}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => {
                      if (option.disabled) return;
                      onChange(option.value);
                      setIsOpen(false);
                    }}
                    className={cn(
                      menuItemClasses,
                      option.value === value && selectedMenuItemClasses,
                      option.disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
