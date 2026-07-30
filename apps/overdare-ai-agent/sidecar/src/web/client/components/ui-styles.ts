// @summary Shared Tailwind class primitives for consistent Web UI surfaces and controls

export const focusRingClasses =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export const iconButtonClasses =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-surface-light hover:text-text " +
  focusRingClasses;

export const panelCloseButtonClasses =
  "rounded-md border border-border/100 bg-fill-secondary px-2 py-1 text-xs text-muted transition hover:bg-fill-ghost-hover hover:text-text " +
  focusRingClasses;

export const fieldClasses =
  "w-full rounded-md border border-border/100 bg-surface-dark px-3 text-sm text-text placeholder:text-text-subtle " +
  focusRingClasses;

export const textAreaBaseClasses = "resize-none overflow-y-auto";

export const textAreaFieldClasses = `${fieldClasses} py-2`;

export const surfaceCardClasses = "rounded-lg border border-border/100 bg-surface-dark";

export const elevatedCardClasses = "rounded-lg border border-border/100 bg-surface-default shadow-panel";

export const emptyStateCardClasses = `mb-8 px-8 py-7 text-center ${elevatedCardClasses}`;

export const panelFrameClasses =
  "absolute inset-0 z-10 flex flex-col border border-border/100 bg-surface-default p-5 shadow-panel";

export const panelHeaderClasses = "mb-4 flex items-start justify-between gap-3";

export const panelBodyClasses = "min-h-0 flex-1 space-y-4 overflow-y-auto pr-1";

export const panelFooterClasses = "mt-4 flex shrink-0 items-center justify-end gap-2";

export const menuPanelClasses = "rounded-md border border-surface-light bg-surface-composer p-1";

export const menuItemClasses =
  "flex h-6 w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded px-2 py-1 text-left font-[Arial] text-xs font-normal leading-4 text-[#DCE2E8] transition hover:bg-[rgba(120,135,156,0.16)]";

export const selectedMenuItemClasses = "bg-[rgba(120,135,156,0.16)] text-[#DCE2E8]";

export const microLabelClasses = "font-mono text-2xs uppercase tracking-wider text-muted";

export const subtleDividerClasses = "border-border/20";

export const sectionStackClasses = "space-y-2";

export const itemStackClasses = "space-y-2";

export const formStackClasses = "space-y-4";

export const actionRowClasses = "flex items-center justify-end gap-2";

export const cardPaddingClasses = "px-3 py-2.5";

export const cardPaddingLooseClasses = "px-3 py-3";

export const toolBlockShellClasses = `overflow-hidden font-mono text-xs ${surfaceCardClasses}`;

export const toolBlockHeaderClasses = `flex items-center gap-2 border-b bg-surface-default px-3 py-2 ${subtleDividerClasses}`;

export const toolBlockHeaderSpreadClasses = `flex items-center justify-between border-b bg-surface-default px-3 py-2 ${subtleDividerClasses}`;

export const toolBlockBodyClasses = "px-3 py-2";

export const toolBlockPreClasses = "overflow-x-auto whitespace-pre-wrap px-3 py-2 leading-relaxed";

export const diffStackClasses = "space-y-1 p-2";

export const controlRowClasses = `flex items-start gap-3 ${surfaceCardClasses} ${cardPaddingClasses}`;

export const badgeClasses = "rounded-md border px-1.5 py-0.5 text-2xs uppercase tracking-wide";

export const pillBadgeClasses = "rounded-full border px-2 py-0.5 text-2xs uppercase tracking-wide";

export const detailPanelClasses = "rounded-md border border-border/40 bg-surface-default px-4 py-3";

export const composerFrameClasses =
  "relative flex min-h-[100px] flex-col justify-between gap-2 rounded-sm border bg-surface-composer px-2 py-2.5";

export const composerTextAreaClasses =
  "block min-h-10 w-full rounded-none border-0 bg-transparent px-0 py-0 text-sm leading-5 text-text placeholder:text-text-subtle focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent";

export const composerToolbarClasses = "flex h-5 shrink-0 items-center justify-between gap-1";

export const composerControlGroupClasses = "flex min-w-0 items-center gap-1";

export const composerActionButtonClasses =
  "inline-flex h-5 items-center justify-center rounded px-2 py-0.5 font-[Arial] text-xs font-normal leading-4 transition disabled:cursor-not-allowed disabled:opacity-30";

export const selectTriggerBaseClasses =
  "inline-flex w-full items-center justify-between gap-1 px-2 font-[Arial] text-xs text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

export const selectTriggerDefaultClasses = "h-7 rounded-md border border-border/100 bg-surface-dark";

export const composerSelectTriggerClasses = "h-5 rounded bg-black";

export const sidebarListClasses = "flex-1 space-y-2 overflow-y-auto bg-bg-sunken px-2 py-3";

export const sidebarItemClasses =
  "w-full rounded-md px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
