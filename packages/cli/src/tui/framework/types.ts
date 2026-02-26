/** Core component interface — pi-agent's proven pattern */
export interface Component {
  /** Render to ANSI-styled lines for the given terminal width */
  render(width: number): string[];
  /** Handle raw input data (optional — not all components are interactive) */
  handleInput?(data: string): void;
  /** Whether this component wants key release events (Kitty protocol) */
  wantsKeyRelease?: boolean;
  /** Clear cached rendering state, forcing full re-render */
  invalidate(): void;

  /** Declare how many leading lines from render() are committed (immutable).
   *  Committed lines are written once to scrollback and never redrawn.
   *  If not implemented, all lines are treated as active (volatile). */
  getCommittedLineCount?(width: number): number;
}

/** Components that can receive hardware cursor focus */
export interface Focusable {
  focused: boolean;
}

/** Size value — absolute pixels or percentage of terminal dimension */
export type SizeValue = number | `${number}%`;

/** Overlay positioning options */
export interface OverlayOptions {
  width?: SizeValue;
  minWidth?: number;
  maxHeight?: SizeValue;
  anchor?: "center" | "bottom-center" | "top-left";
  offsetX?: number;
  offsetY?: number;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

/** Handle returned when showing an overlay */
export interface OverlayHandle {
  hide(): void;
  isHidden(): boolean;
  setHidden(hidden: boolean): void;
}

/** Zero-width cursor marker — components embed this where the hardware cursor should be.
 * Uses APC (Application Program Command) sequence which all terminals ignore visually. */
export const CURSOR_MARKER = "\x1b_diligent:c\x07";
