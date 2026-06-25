// @summary Input dock with auto-resize textarea, slash command autocomplete, model/effort controls, and usage tray

import type { Mode, ModelInfo, ThinkingEffort, ThreadStatus } from "@diligent/protocol";
import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentContextItem } from "../lib/agent-native-bridge";
import { findModelInfo, getThinkingEffortOptions } from "../lib/model-thinking-helpers";
import type { SlashCommand } from "../lib/slash-commands";
import { BUILTIN_COMMANDS, filterCommands, isSlashPrefix } from "../lib/slash-commands";
import type { UsageState } from "../lib/thread-store";
import { ComposerContextChips } from "./ComposerContextChips";
import { Select, type SelectOption } from "./Select";
import { SlashMenu } from "./SlashMenu";
import { TextArea } from "./TextArea";
import { useAnchoredPortal } from "./useAnchoredPortal";

interface InputDockProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onCompactionClick: () => void;
  isCompacting: boolean;
  canSend: boolean;
  canSteer: boolean;
  threadStatus: ThreadStatus;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  effort: ThinkingEffort;
  onEffortChange: (effort: ThinkingEffort) => void;
  currentModel: string;
  availableModels: ModelInfo[];
  onModelChange: (modelId: string) => void;
  usage: UsageState;
  currentContextTokens: number;
  contextWindow: number;
  hasProvider: boolean;
  hasBlockingPrompt?: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  pendingImages: Array<{ path: string; url: string; fileName?: string }>;
  contextItems: AgentContextItem[];
  isUploadingImages: boolean;
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (path: string) => void;
  onRemoveContextItem: (key: string) => void;
  onClearContextItems: () => void;
  /** Handler for slash command execution */
  onSlashCommand?: (name: string, arg?: string) => void;
  /** Full list of available slash commands (builtins + skills). Falls back to builtins only. */
  slashCommands?: SlashCommand[];
}

type ComposerMenuKey = "mode" | "compaction";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function extractPastedImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];

  const filesFromItems = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file" && SUPPORTED_IMAGE_MIME_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file instanceof File);

  if (filesFromItems.length > 0) {
    return filesFromItems;
  }

  return Array.from(clipboardData.files ?? []).filter((file) => SUPPORTED_IMAGE_MIME_TYPES.has(file.type));
}

const MODE_LABELS: Record<Mode, string> = {
  default: "default",
  plan: "plan",
  execute: "execute",
};

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsageTooltip(usage: UsageState): string {
  return [
    `Input: ${usage.inputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()}`,
    `Cache read: ${usage.cacheReadTokens.toLocaleString()}`,
    `Cache write: ${usage.cacheWriteTokens.toLocaleString()}`,
  ].join("\n");
}

function modelOptions(models: ModelInfo[]): SelectOption[] {
  return models.map((model) => ({
    value: model.id,
    label: model.id,
    group: model.provider,
  }));
}

function modeOptions(): SelectOption[] {
  return (Object.keys(MODE_LABELS) as Mode[]).map((m) => ({
    value: m,
    label: MODE_LABELS[m],
  }));
}

export function InputDock({
  input,
  onInputChange,
  onSend,
  onSteer,
  onInterrupt,
  onCompactionClick,
  isCompacting,
  canSend,
  canSteer,
  threadStatus,
  mode,
  onModeChange,
  effort,
  onEffortChange,
  currentModel,
  availableModels,
  onModelChange,
  usage,
  currentContextTokens,
  contextWindow,
  hasProvider,
  hasBlockingPrompt = false,
  supportsVision,
  supportsThinking,
  pendingImages,
  contextItems,
  isUploadingImages,
  onAddImages,
  onRemoveImage,
  onRemoveContextItem,
  onClearContextItems,
  onSlashCommand,
  slashCommands,
}: InputDockProps) {
  const composingRef = useRef(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuPopupRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuPopupRef = useRef<HTMLDivElement>(null);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<ComposerMenuKey | null>(null);

  // Slash command autocomplete state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFiltered, setSlashFiltered] = useState<SlashCommand[]>([]);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  const isBusy = threadStatus === "busy";
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const hasUsage = totalTokens > 0;
  const hasContext = currentContextTokens > 0;
  const contextPct = contextWindow > 0 ? Math.round((currentContextTokens / contextWindow) * 100) : 0;
  const usageLabel = hasContext
    ? `${formatTokenCount(currentContextTokens)} / ${formatTokenCount(contextWindow)} (${contextPct}%)`
    : hasUsage
      ? `${formatTokenCount(totalTokens)} tokens`
      : null;

  // Update slash menu when input changes
  const updateSlashMenu = useCallback(
    (value: string) => {
      if (isSlashPrefix(value)) {
        const partial = value.slice(1);
        const filtered = filterCommands(slashCommands ?? BUILTIN_COMMANDS, partial);
        setSlashFiltered(filtered);
        setSlashMenuOpen(filtered.length > 0);
        setSlashSelectedIndex(0);
      } else {
        setSlashMenuOpen(false);
        setSlashFiltered([]);
      }
    },
    [slashCommands],
  );

  const closeSlashMenu = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashFiltered([]);
  }, []);

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      closeSlashMenu();
      onInputChange("");
      onSlashCommand?.(cmd.name);
    },
    [onSlashCommand, onInputChange, closeSlashMenu],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      onInputChange(value);
      updateSlashMenu(value);
    },
    [onInputChange, updateSlashMenu],
  );

  const modeMenuOptions = modeOptions();
  const currentModelInfo = findModelInfo(availableModels, currentModel);
  const effortMenuOptions: SelectOption[] = getThinkingEffortOptions(currentModelInfo).map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const showEffortSelector = supportsThinking && effortMenuOptions.length > 0;

  const plusMenuPosition = useAnchoredPortal({
    open: isPlusMenuOpen,
    anchorRef: plusMenuRef,
    popupRef: plusMenuPopupRef,
    onClose: () => {
      setIsPlusMenuOpen(false);
      setActiveSubmenu(null);
    },
  });

  const slashMenuPosition = useAnchoredPortal({
    open: slashMenuOpen,
    anchorRef: slashMenuRef,
    popupRef: slashMenuPopupRef,
    onClose: closeSlashMenu,
  });

  const openPlusMenu = () => {
    setIsPlusMenuOpen(true);
    setActiveSubmenu(null);
  };

  const togglePlusMenu = () => {
    if (isPlusMenuOpen) {
      setIsPlusMenuOpen(false);
      setActiveSubmenu(null);
      return;
    }
    openPlusMenu();
  };

  const topLevelMenuItemClass = (menuKey: ComposerMenuKey): string =>
    `flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-xs transition ${
      activeSubmenu === menuKey
        ? "border border-border/100 bg-fill-secondary text-text"
        : "border border-transparent text-muted hover:border-border/100 hover:bg-fill-ghost-hover hover:text-text"
    }`;

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = extractPastedImageFiles(event.clipboardData);
    if (pastedImages.length === 0) return;

    event.preventDefault();
    if (isUploadingImages) return;
    onAddImages(pastedImages);
  };

  // Handle keyboard events — slash menu navigation takes priority when open
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;

    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelectedIndex((prev) => Math.min(prev + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = slashFiltered[slashSelectedIndex];
        if (cmd) handleSlashSelect(cmd);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = slashFiltered[slashSelectedIndex];
        if (cmd) {
          onInputChange(`/${cmd.name} `);
          closeSlashMenu();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }

    // Normal key handling
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (hasBlockingPrompt) return;
      if (isBusy) onSteer();
      else if (!isUploadingImages && hasProvider) onSend();
    }
  };

  const composerDisabled = !hasProvider || hasBlockingPrompt;
  const canRenderPlusMenuPortal = isPlusMenuOpen && plusMenuPosition && typeof document !== "undefined";
  const canRenderSlashMenuPortal = slashMenuOpen && slashMenuPosition && typeof document !== "undefined";

  return (
    <div className="relative z-20 bg-surface-dark px-2 pb-4 pt-2">
      <div
        className={`relative rounded-sm border px-4 py-3 ${hasProvider ? "border-white/10 !bg-[#21262C]" : "border-danger/30 !bg-[#21262C]"}${isBusy ? " input-dock-glow" : ""}`}
      >
        {pendingImages.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {pendingImages.map((image) => (
              <div
                key={image.path}
                className="group relative overflow-hidden rounded-lg border border-border/100 bg-surface-light"
              >
                <img src={image.url} alt={image.fileName ?? "Attached image"} className="h-20 w-20 object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${image.fileName ?? "image"}`}
                  onClick={() => onRemoveImage(image.path)}
                  disabled={isUploadingImages || composerDisabled}
                  className="absolute right-1 top-1 rounded-full bg-bg/80 px-1.5 py-0.5 text-[10px] text-text opacity-90 transition hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            ))}
            {isUploadingImages ? (
              <div className="flex h-20 min-w-[120px] items-center justify-center rounded-lg border border-dashed border-border/100 bg-surface-dark px-3 text-xs text-muted">
                Uploading images…
              </div>
            ) : null}
          </div>
        ) : isUploadingImages ? (
          <div className="mb-3 flex h-20 items-center justify-center rounded-lg border border-dashed border-border/100 bg-surface-dark px-3 text-xs text-muted">
            Uploading images…
          </div>
        ) : null}

        <ComposerContextChips items={contextItems} onRemove={onRemoveContextItem} onClear={onClearContextItems} />

        <div ref={slashMenuRef} className="relative flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <TextArea
              className="min-h-[52px] border-0 bg-transparent !px-1 py-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent"
              aria-label={hasBlockingPrompt ? "Prompt response pending" : isBusy ? "Steering input" : "Message input"}
              placeholder={
                hasBlockingPrompt
                  ? "Answer the prompt above…"
                  : isBusy
                    ? "Steer the agent…"
                    : supportsVision
                      ? "Ask anything or attach images…"
                      : "Ask anything…"
              }
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              disabled={composerDisabled}
            />
          </div>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <div ref={plusMenuRef} className="relative shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={isUploadingImages || composerDisabled}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onAddImages(e.target.files);
                    e.target.value = "";
                  }
                }}
              />

              <button
                type="button"
                aria-label="Open composer options"
                aria-haspopup="menu"
                aria-expanded={isPlusMenuOpen}
                onClick={togglePlusMenu}
                disabled={composerDisabled}
                className={`inline-flex h-7 w-7 items-center justify-center rounded border text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text/10 ${
                  isPlusMenuOpen
                    ? "border-border/100 bg-fill-secondary text-text"
                    : "border-transparent bg-surface-light text-muted/80 hover:border-border/100 hover:bg-fill-ghost-hover hover:text-text"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                +
              </button>
            </div>

            {availableModels.length > 0 ? (
              <Select
                ariaLabel="Model selector"
                value={currentModel}
                options={modelOptions(availableModels)}
                onChange={onModelChange}
                openDirection="up"
                className="w-[180px]"
                triggerClassName="border-0 !bg-black rounded"
                disabled={isBusy || composerDisabled}
              />
            ) : null}

            {showEffortSelector ? (
              <Select
                ariaLabel="Effort selector"
                value={effort}
                options={effortMenuOptions}
                onChange={(value) => onEffortChange(value as ThinkingEffort)}
                openDirection="up"
                className="w-[90px]"
                triggerClassName="border-0 !bg-black rounded"
                disabled={isBusy || composerDisabled}
              />
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {usageLabel ? (
              <span className="mr-1 shrink-0 cursor-default text-xs text-muted/70" title={formatUsageTooltip(usage)}>
                {usageLabel}
              </span>
            ) : null}

            {isBusy ? (
              <>
                <button
                  type="button"
                  aria-label="Steer agent"
                  onClick={() => {
                    if (hasBlockingPrompt) return;
                    if (!composingRef.current) onSteer();
                  }}
                  disabled={!canSteer || hasBlockingPrompt}
                  className="rounded-full bg-fill-secondary px-3 py-1.5 text-xs font-semibold text-text transition hover:bg-fill-ghost-hover disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Steer
                </button>
                <button
                  type="button"
                  aria-label="Interrupt turn"
                  onClick={onInterrupt}
                  className="rounded-md border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger transition hover:bg-danger/20"
                >
                  Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                onClick={() => {
                  if (!composingRef.current) onSend();
                }}
                disabled={!canSend || composerDisabled}
                className="rounded-full bg-fill-primary px-3 py-1.5 text-xs font-semibold text-text transition hover:!bg-[#BB002F] disabled:cursor-not-allowed disabled:opacity-30"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
      {canRenderPlusMenuPortal
        ? createPortal(
            <div
              ref={plusMenuPopupRef}
              role="menu"
              className="fixed z-[100] min-w-[150px] rounded-xl border border-border/100 bg-surface-dark p-1 shadow-panel"
              style={{
                left: plusMenuPosition.left,
                bottom: plusMenuPosition.bottom,
              }}
            >
              <div className="relative">
                <div className="relative">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setIsPlusMenuOpen(false);
                      setActiveSubmenu(null);
                    }}
                    disabled={!supportsVision || isUploadingImages}
                    className={`block w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${
                      supportsVision && !isUploadingImages
                        ? "text-muted hover:bg-fill-ghost-hover hover:text-text"
                        : "cursor-not-allowed text-muted/40"
                    }`}
                  >
                    {isUploadingImages ? "Uploading images…" : "Add images"}
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={activeSubmenu === "mode"}
                    onMouseEnter={() => setActiveSubmenu("mode")}
                    onFocus={() => setActiveSubmenu("mode")}
                    onClick={() => setActiveSubmenu("mode")}
                    className={topLevelMenuItemClass("mode")}
                  >
                    <span>Mode</span>
                    <span className="text-[10px] opacity-60">›</span>
                  </button>

                  {activeSubmenu === "mode" ? (
                    <div className="absolute left-full top-0 z-[110] ml-1 min-w-[132px] rounded-xl border border-border/100 bg-surface-dark p-1 shadow-panel">
                      {modeMenuOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.value === mode}
                          onClick={() => {
                            onModeChange(option.value as Mode);
                            setIsPlusMenuOpen(false);
                            setActiveSubmenu(null);
                          }}
                          className={`block w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${
                            option.value === mode
                              ? "bg-fill-active text-text"
                              : "text-muted hover:bg-fill-ghost-hover hover:text-text"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="relative">
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={activeSubmenu === "compaction"}
                    onMouseEnter={() => setActiveSubmenu("compaction")}
                    onFocus={() => setActiveSubmenu("compaction")}
                    onClick={() => setActiveSubmenu("compaction")}
                    className={topLevelMenuItemClass("compaction")}
                  >
                    <span>Compaction</span>
                    <span className="text-[10px] opacity-60">›</span>
                  </button>

                  {activeSubmenu === "compaction" ? (
                    <div className="absolute left-full top-0 z-[110] ml-1 min-w-[156px] rounded-xl border border-border/100 bg-surface-dark p-1 shadow-panel">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onCompactionClick();
                          setIsPlusMenuOpen(false);
                          setActiveSubmenu(null);
                        }}
                        disabled={isCompacting}
                        className={`block w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${
                          isCompacting
                            ? "cursor-not-allowed text-muted/40"
                            : "text-muted hover:bg-fill-ghost-hover hover:text-text"
                        }`}
                      >
                        Compact now
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {canRenderSlashMenuPortal
        ? createPortal(
            <div ref={slashMenuPopupRef}>
              <SlashMenu
                commands={slashFiltered}
                selectedIndex={slashSelectedIndex}
                onSelect={handleSlashSelect}
                className="fixed z-[100] w-[280px] overflow-hidden rounded-xl border border-border/100 bg-surface-dark shadow-panel"
                style={{
                  left: slashMenuPosition.left,
                  bottom: slashMenuPosition.bottom,
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
