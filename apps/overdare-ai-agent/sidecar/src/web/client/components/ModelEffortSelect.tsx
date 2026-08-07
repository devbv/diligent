// @summary Merged composer control: usage-gauge model pill opening a Models menu with an Effort row beneath it

import type { ModelInfo, ThinkingEffort } from "@diligent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { getThinkingEffortOptions, modelOptionKey } from "../lib/model-thinking-helpers";
import { Check, TriangleArrowDown, TriangleArrowRight } from "./icons";
import { formatUsageTooltipLabel, getUsageGaugeRatio, UsageGauge, UsageTooltip } from "./UsageGauge";
import {
  composerMenuGroupClasses,
  composerMenuHeaderClasses,
  composerMenuPanelClasses,
  focusRingClasses,
  menuItemClasses,
  selectedMenuItemClasses,
} from "./ui-styles";
import { useAnchoredPortal } from "./useAnchoredPortal";

/** Design `menu/header` height, `menu` inset, and `menu/item` height — used to size and place the submenu. */
const MENU_HEADER_HEIGHT = 28;
const MENU_GROUP_PADDING = 8;
const MENU_ITEM_HEIGHT = 24;
/** Design places the Effort panel 2px to the right of the Models panel. */
const SUBMENU_GAP = 2;
const VIEWPORT_MARGIN = 8;
const MODELS_MENU_WIDTH = 200;
const EFFORT_MENU_WIDTH = 180;

/**
 * Side-by-side panels need both widths plus the gap and page margins. Below that the Effort list
 * would sit off-screen, so the narrow layout drills down inside the Models panel instead.
 */
export function canFitEffortBeside(viewportWidth: number): boolean {
  return viewportWidth >= MODELS_MENU_WIDTH + SUBMENU_GAP + EFFORT_MENU_WIDTH + 2 * VIEWPORT_MARGIN;
}

/** The panel's 1px hairline sits outside the auto height, so it counts toward the outer box. */
const MENU_BORDER = 2;
/** The rule between the model rows and the Effort row adds no margin of its own — the 4px group insets carry the spacing. */
const MENU_DIVIDER_BLOCK = 1;

/** Full Models panel: hairline, `Models` header, model rows, divider, and the single Effort row. */
export function getModelsMenuHeight(modelCount: number): number {
  return (
    MENU_BORDER +
    MENU_HEADER_HEIGHT +
    (MENU_GROUP_PADDING + modelCount * MENU_ITEM_HEIGHT) +
    MENU_DIVIDER_BLOCK +
    (MENU_GROUP_PADDING + MENU_ITEM_HEIGHT)
  );
}

/** The Effort panel carries no header of its own — design measures 180x130 for five rows. */
export function getEffortMenuHeight(itemCount: number): number {
  return MENU_BORDER + MENU_GROUP_PADDING + itemCount * MENU_ITEM_HEIGHT;
}

function getModelDisplayLabel(model: ModelInfo): string {
  return model.display ?? model.modelId;
}

interface SubmenuPosition {
  left: number;
  top: number;
}

/**
 * The Effort row sits at the bottom of the Models panel, so the design bottom-aligns the two panels
 * and offsets the submenu 2px to the right.
 */
export function getEffortMenuPosition(args: {
  panelRect: { bottom: number; right: number };
  submenuHeight: number;
  viewportHeight: number;
}): SubmenuPosition {
  const maxTop = Math.max(VIEWPORT_MARGIN, args.viewportHeight - args.submenuHeight - VIEWPORT_MARGIN);
  return {
    left: args.panelRect.right + SUBMENU_GAP,
    top: Math.min(Math.max(args.panelRect.bottom - args.submenuHeight, VIEWPORT_MARGIN), maxTop),
  };
}

interface ModelEffortSelectProps {
  currentModel: string;
  availableModels: ModelInfo[];
  onModelChange: (modelId: string) => void;
  effort: ThinkingEffort;
  onEffortChange: (effort: ThinkingEffort) => void;
  supportsThinking: boolean;
  currentContextTokens: number;
  contextWindow: number;
  disabled?: boolean;
}

export function ModelEffortSelect({
  currentModel,
  availableModels,
  onModelChange,
  effort,
  onEffortChange,
  supportsThinking,
  currentContextTokens,
  contextWindow,
  disabled = false,
}: ModelEffortSelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState<SubmenuPosition | null>(null);
  /** Narrow viewports show the Effort list in place of the model list rather than beside it. */
  const [isEffortView, setIsEffortView] = useState(false);
  const [tooltipCursor, setTooltipCursor] = useState<{ x: number; y: number } | null>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setSubmenuPosition(null);
    setIsEffortView(false);
  }, []);

  const panelPosition = useAnchoredPortal({
    open: isOpen,
    anchorRef: triggerRef,
    popupRef,
    onClose: close,
  });

  useEffect(() => {
    if (isOpen) setTooltipCursor(null);
  }, [isOpen]);

  const currentModelInfo = availableModels.find((model) => modelOptionKey(model) === currentModel);
  const currentEffortOptions = getThinkingEffortOptions(currentModelInfo);
  const showEffort = supportsThinking && currentEffortOptions.length > 0;
  const modelLabel = currentModelInfo ? getModelDisplayLabel(currentModelInfo) : currentModel;
  const effortLabel = currentEffortOptions.find((option) => option.value === effort)?.label ?? effort;

  const usageRatio = getUsageGaugeRatio(currentContextTokens, contextWindow);
  const usageLabel = formatUsageTooltipLabel(currentContextTokens, contextWindow);

  /** Hover only ever opens the side panel — drilling down on hover would swap the list out from under the pointer. */
  const openEffortBeside = useCallback(() => {
    if (currentEffortOptions.length === 0) return;
    if (!canFitEffortBeside(window.innerWidth)) return;
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return;
    setSubmenuPosition(
      getEffortMenuPosition({
        panelRect,
        submenuHeight: getEffortMenuHeight(currentEffortOptions.length),
        viewportHeight: window.innerHeight,
      }),
    );
  }, [currentEffortOptions.length]);

  const activateEffort = useCallback(() => {
    if (currentEffortOptions.length === 0) return;
    if (canFitEffortBeside(window.innerWidth)) {
      openEffortBeside();
      return;
    }
    setSubmenuPosition(null);
    setIsEffortView(true);
  }, [currentEffortOptions.length, openEffortBeside]);

  const selectModel = useCallback(
    (model: ModelInfo) => {
      onModelChange(modelOptionKey(model));
      close();
    },
    [close, onModelChange],
  );

  const selectEffort = useCallback(
    (value: ThinkingEffort) => {
      onEffortChange(value);
      close();
    },
    [close, onEffortChange],
  );

  const canRenderPortal = isOpen && panelPosition && typeof document !== "undefined";

  return (
    <div className="relative flex h-5 min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Model selector"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        // `aria-disabled` rather than `disabled`: a natively disabled button swallows the
        // hover events the usage tooltip needs, and usage matters most mid-turn.
        aria-disabled={disabled}
        onClick={() => !disabled && (isOpen ? close() : setIsOpen(true))}
        className={cn(
          "inline-flex h-5 min-w-0 items-center gap-1 rounded bg-black px-2 font-[Arial] text-xs font-normal leading-4 transition",
          focusRingClasses,
          disabled ? "cursor-not-allowed opacity-40" : "hover:bg-[#12161B]",
        )}
      >
        {contextWindow > 0 ? (
          <span
            className="flex shrink-0 items-center"
            onMouseMove={(event) => setTooltipCursor({ x: event.clientX, y: event.clientY })}
            onMouseLeave={() => setTooltipCursor(null)}
          >
            <UsageGauge ratio={usageRatio} />
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[#DCE2E8]">{modelLabel}</span>
        {showEffort ? <span className="shrink-0 text-[#565F69]">{effortLabel}</span> : null}
        <TriangleArrowDown
          className={cn("h-2 w-2 shrink-0 text-[#88929C] transition-transform", isOpen && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      <UsageTooltip cursor={isOpen ? null : tooltipCursor} label={usageLabel} />

      {canRenderPortal
        ? createPortal(
            <div ref={popupRef}>
              <div
                ref={panelRef}
                role="menu"
                aria-label="Models"
                className={cn("fixed z-composer-menu w-[200px]", composerMenuPanelClasses)}
                style={{ left: panelPosition.left, bottom: panelPosition.bottom }}
              >
                {isEffortView ? (
                  <button
                    type="button"
                    aria-label="Back to models"
                    onClick={() => setIsEffortView(false)}
                    className={cn(composerMenuHeaderClasses, "w-full gap-2 text-left hover:text-white")}
                  >
                    <TriangleArrowRight className="h-3 w-3 shrink-0 rotate-180" aria-hidden="true" />
                    <span>Effort</span>
                  </button>
                ) : (
                  <div className={composerMenuHeaderClasses}>Models</div>
                )}

                {isEffortView ? (
                  <div className={cn(composerMenuGroupClasses, "max-h-[50vh] overflow-y-auto")}>
                    {currentEffortOptions.map((option) => {
                      const isSelected = option.value === effort;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => selectEffort(option.value)}
                          className={cn(menuItemClasses, "gap-2", isSelected && selectedMenuItemClasses)}
                        >
                          <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                            {isSelected ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <div className={cn(composerMenuGroupClasses, "max-h-[50vh] overflow-y-auto")}>
                      {availableModels.map((model) => {
                        const key = modelOptionKey(model);
                        const isSelected = key === currentModel;
                        return (
                          <button
                            key={key}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isSelected}
                            onMouseEnter={() => setSubmenuPosition(null)}
                            onFocus={() => setSubmenuPosition(null)}
                            onClick={() => selectModel(model)}
                            className={cn(menuItemClasses, "gap-2", isSelected && selectedMenuItemClasses)}
                          >
                            <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                              {isSelected ? <Check className="h-3 w-3" /> : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-left">{getModelDisplayLabel(model)}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Effort is its own row under the model list, not a per-model submenu. */}
                    <div className="border-t border-[#2A3038]" />
                    <div className={composerMenuGroupClasses}>
                      <button
                        type="button"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={submenuPosition !== null}
                        disabled={currentEffortOptions.length === 0}
                        onMouseEnter={openEffortBeside}
                        onFocus={openEffortBeside}
                        onClick={activateEffort}
                        className={cn(
                          menuItemClasses,
                          "gap-2",
                          submenuPosition !== null && selectedMenuItemClasses,
                          currentEffortOptions.length === 0 && "cursor-not-allowed text-muted/40",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">Effort</span>
                        <TriangleArrowRight className="h-3 w-3 shrink-0 text-[#DCE2E8]" aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {submenuPosition && currentEffortOptions.length > 0 ? (
                <div
                  role="menu"
                  aria-label="Effort"
                  className={cn("fixed z-composer-submenu w-[180px]", composerMenuPanelClasses)}
                  style={{ left: submenuPosition.left, top: submenuPosition.top }}
                >
                  <div className={composerMenuGroupClasses}>
                    {currentEffortOptions.map((option) => {
                      const isSelected = option.value === effort;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => selectEffort(option.value)}
                          className={cn(menuItemClasses, "gap-2", isSelected && selectedMenuItemClasses)}
                        >
                          <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                            {isSelected ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
