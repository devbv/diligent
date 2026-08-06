// @summary Input dock with auto-resize textarea, slash command autocomplete, model/effort controls, and usage tray

import type { Mode, ModelInfo, ThinkingEffort, ThreadStatus } from "@diligent/protocol";
import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentContextItem } from "../lib/agent-native-bridge";
import type { SlashCommand } from "../lib/slash-commands";
import { BUILTIN_COMMANDS, filterCommands, isSlashPrefix } from "../lib/slash-commands";
import { ComposerContextChips } from "./ComposerContextChips";
import { AgentLogo, ArrowUp, Check, Plus, Stop, TriangleArrowRight, X } from "./icons";
import { ModelEffortSelect } from "./ModelEffortSelect";
import { SlashMenu } from "./SlashMenu";
import { TextArea } from "./TextArea";
import {
  composerActionButtonClasses,
  composerControlGroupClasses,
  composerFrameClasses,
  composerSendButtonClasses,
  composerStopButtonClasses,
  composerToolbarClasses,
  focusRingClasses,
  menuItemClasses,
  menuPanelClasses,
  selectedMenuItemClasses,
} from "./ui-styles";
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
  currentContextTokens: number;
  contextWindow: number;
  hasProvider: boolean;
  hasBlockingPrompt?: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  pendingImages: Array<{ path: string; url: string; fileName?: string }>;
  contextItems: AgentContextItem[];
  isUploadingImages: boolean;
  showImageUploadIndicator?: boolean;
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

function UploadSpinner() {
  return (
    <output aria-label="Uploading image" className="inline-flex h-6 w-6 items-center justify-center">
      <span
        data-icon="upload-spinner"
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-[3px] border-white/20 border-t-white motion-reduce:animate-none"
      />
      <span className="sr-only">Uploading…</span>
    </output>
  );
}

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
  default: "Default",
  plan: "Plan",
  execute: "Execute",
};

const MODE_BADGE_LABELS: Record<Exclude<Mode, "default">, string> = {
  plan: "Plan",
  execute: "Execute",
};

const MODE_BADGE_CLASSES: Record<Exclude<Mode, "default">, string> = {
  plan: "w-[29px] bg-[#2A3038] text-[#88929C]",
  execute: "w-[45px] bg-[rgba(49,145,255,0.24)] text-[#64AFFF]",
};

export function getModeLabel(mode: Mode): string {
  return MODE_LABELS[mode];
}

export function getModeBadgeLabel(mode: Mode): string | null {
  return mode === "default" ? null : MODE_BADGE_LABELS[mode];
}

export function getModeBadgeClasses(mode: Mode): string | null {
  return mode === "default" ? null : MODE_BADGE_CLASSES[mode];
}

function PendingImagePreview({
  image,
  isUploadingImages,
  composerDisabled,
  onRemoveImage,
}: {
  image: { path: string; url: string; fileName?: string };
  isUploadingImages: boolean;
  composerDisabled: boolean;
  onRemoveImage: (path: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const label = image.fileName ?? "Attached image";

  return (
    <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded border border-border/100 bg-surface-light">
      {failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-2xs text-muted">
          <span className="font-semibold text-text">IMG</span>
          <span className="line-clamp-2 max-w-full break-all">{label}</span>
        </div>
      ) : (
        <img src={image.url} alt={label} className="h-full w-full object-cover" onError={() => setFailed(true)} />
      )}
      <button
        type="button"
        aria-label={`Remove ${image.fileName ?? "image"}`}
        onClick={() => onRemoveImage(image.path)}
        disabled={isUploadingImages || composerDisabled}
        className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-[2px] border-0 bg-transparent p-0 text-[#DCE2E8] drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] transition hover:bg-[#2A3038] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

export type ComposerEnterAction = "send" | "steer" | "none";

export function getComposerEnterAction(args: {
  hasBlockingPrompt: boolean;
  isBusy: boolean;
  canSend: boolean;
  canSteer: boolean;
  isUploadingImages: boolean;
  hasProvider: boolean;
}): ComposerEnterAction {
  if (args.hasBlockingPrompt) return "none";
  if (args.isBusy) return args.canSteer ? "steer" : "none";
  return args.canSend && !args.isUploadingImages && args.hasProvider ? "send" : "none";
}

function modeOptions(): Array<{ value: Mode; label: string }> {
  return (Object.keys(MODE_LABELS) as Mode[]).map((m) => ({
    value: m,
    label: getModeLabel(m),
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
  currentContextTokens,
  contextWindow,
  hasProvider,
  hasBlockingPrompt = false,
  supportsVision,
  supportsThinking,
  pendingImages,
  contextItems,
  isUploadingImages,
  showImageUploadIndicator = isUploadingImages,
  onAddImages,
  onRemoveImage,
  onRemoveContextItem,
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
    `flex h-6 w-full items-center justify-between rounded px-2 py-1 text-left font-[Arial] text-xs font-normal leading-4 text-[#DCE2E8] transition ${
      activeSubmenu === menuKey ? selectedMenuItemClasses : "hover:bg-[rgba(120,135,156,0.16)]"
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
      const action = getComposerEnterAction({
        hasBlockingPrompt,
        isBusy,
        canSend,
        canSteer,
        isUploadingImages,
        hasProvider,
      });
      if (action === "steer") onSteer();
      if (action === "send") onSend();
    }
  };

  const composerDisabled = !hasProvider;
  const sendDisabled = !canSend || composerDisabled || hasBlockingPrompt;
  const canRenderPlusMenuPortal = isPlusMenuOpen && plusMenuPosition && typeof document !== "undefined";
  const canRenderSlashMenuPortal = slashMenuOpen && slashMenuPosition && typeof document !== "undefined";
  const modeBadgeLabel = getModeBadgeLabel(mode);
  const modeBadgeClasses = getModeBadgeClasses(mode);

  return (
    <div className="relative z-20 bg-surface-dark px-2 pb-2">
      <div
        className={`${composerFrameClasses} ${hasProvider ? "border-white/[0.12]" : "border-danger/30"}${isBusy ? " input-dock-glow" : ""}`}
      >
        {pendingImages.length > 0 || showImageUploadIndicator ? (
          <section aria-label="Image attachments" className="flex flex-wrap gap-2">
            {pendingImages.map((image) => (
              <PendingImagePreview
                key={image.path}
                image={image}
                isUploadingImages={isUploadingImages}
                composerDisabled={composerDisabled}
                onRemoveImage={onRemoveImage}
              />
            ))}
            {showImageUploadIndicator ? (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded border border-dashed border-border/100 bg-surface-dark px-2 text-center text-xs text-muted">
                <UploadSpinner />
              </div>
            ) : null}
          </section>
        ) : null}

        <ComposerContextChips items={contextItems} onRemove={onRemoveContextItem} />

        <div ref={slashMenuRef} className="relative flex items-start gap-2">
          <div className="relative min-w-0 flex-1">
            {input.length === 0 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 flex h-5 items-center gap-0.5 text-white"
              >
                <AgentLogo className="h-5 w-5 shrink-0 text-[#565F69]" />
                <span className="text-sm leading-5">
                  {isBusy ? "Queue a message…" : supportsVision ? "Ask anything or attach images…" : "Ask anything…"}
                </span>
              </div>
            ) : null}
            <TextArea
              variant="composer"
              aria-label={isBusy ? "Queue input" : "Message input"}
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
              className={contextItems.length > 0 ? "!min-h-5" : undefined}
            />
          </div>
        </div>

        <div className={composerToolbarClasses}>
          <div className={composerControlGroupClasses}>
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
                className={`inline-flex h-5 w-5 items-center justify-center rounded bg-[#2A3038] text-[#88929C] transition hover:bg-[#353C44] hover:text-[#DCE2E8] ${focusRingClasses} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <Plus className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>

            {modeBadgeLabel && modeBadgeClasses ? (
              <div
                className={`pointer-events-none inline-flex h-5 shrink-0 items-center justify-center rounded px-1 text-[10px] font-normal leading-3 ${modeBadgeClasses}`}
                title={`Current mode: ${modeBadgeLabel}`}
              >
                {modeBadgeLabel}
              </div>
            ) : null}

            {availableModels.length > 0 ? (
              <ModelEffortSelect
                currentModel={currentModel}
                availableModels={availableModels}
                onModelChange={onModelChange}
                effort={effort}
                onEffortChange={onEffortChange}
                supportsThinking={supportsThinking}
                currentContextTokens={currentContextTokens}
                contextWindow={contextWindow}
                disabled={isBusy || composerDisabled}
              />
            ) : null}
          </div>

          <div className={`${composerControlGroupClasses} ml-auto justify-end`}>
            {isBusy ? (
              <>
                <button
                  type="button"
                  aria-label="Queue message"
                  onClick={() => {
                    if (hasBlockingPrompt) return;
                    if (!canSteer) return;
                    if (!composingRef.current) onSteer();
                  }}
                  disabled={!canSteer || hasBlockingPrompt}
                  className={`${composerActionButtonClasses} bg-transparent text-[#DCE2E8] hover:bg-[rgba(120,135,156,0.16)] disabled:text-[#565F69] disabled:opacity-100 disabled:hover:bg-transparent`}
                >
                  Queue
                </button>
                <button
                  type="button"
                  aria-label="Interrupt turn"
                  onClick={onInterrupt}
                  className={composerStopButtonClasses}
                >
                  <Stop className="h-3 w-3" aria-hidden="true" />
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                onClick={() => {
                  if (sendDisabled) return;
                  if (!composingRef.current) onSend();
                }}
                disabled={sendDisabled}
                className={composerSendButtonClasses}
              >
                <ArrowUp className="h-3 w-3" aria-hidden="true" />
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
              aria-label="Composer options"
              className={`fixed z-composer-menu h-[80px] w-[200px] ${menuPanelClasses}`}
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
                    onMouseEnter={() => setActiveSubmenu(null)}
                    onFocus={() => setActiveSubmenu(null)}
                    disabled={!supportsVision || isUploadingImages}
                    className={`${menuItemClasses} ${
                      supportsVision && !isUploadingImages ? "" : "cursor-not-allowed text-muted/40"
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
                    <span>Mode text</span>
                    <TriangleArrowRight className="h-3 w-3 shrink-0 text-[#DCE2E8]" aria-hidden="true" />
                  </button>

                  {activeSubmenu === "mode" ? (
                    <div
                      role="menu"
                      aria-label="Mode options"
                      className={`absolute bottom-0 left-full z-composer-submenu ml-2 h-[80px] w-[180px] ${menuPanelClasses}`}
                    >
                      {modeMenuOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.value === mode}
                          onClick={() => {
                            onModeChange(option.value);
                            setIsPlusMenuOpen(false);
                            setActiveSubmenu(null);
                          }}
                          className={menuItemClasses}
                        >
                          <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                            {option.value === mode ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="ml-2">{option.label}</span>
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
                    <TriangleArrowRight className="h-3 w-3 shrink-0 text-[#DCE2E8]" aria-hidden="true" />
                  </button>

                  {activeSubmenu === "compaction" ? (
                    <div className={`absolute left-full top-0 z-composer-submenu ml-2 min-w-40 ${menuPanelClasses}`}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onCompactionClick();
                          setIsPlusMenuOpen(false);
                          setActiveSubmenu(null);
                        }}
                        disabled={isCompacting}
                        className={`${menuItemClasses} ${isCompacting ? "cursor-not-allowed text-muted/40" : ""}`}
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
                className={`fixed z-composer-menu w-72 overflow-hidden ${menuPanelClasses}`}
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
