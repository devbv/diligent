// --- Primitives (raw ANSI codes) ---
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const INVERSE = "\x1b[7m";
const BOLD_OFF = "\x1b[22m";
const ITALIC_OFF = "\x1b[23m";
const UNDERLINE_OFF = "\x1b[24m";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DARK_GREEN = "\x1b[38;5;28m";
const BG_GRAY = "\x1b[48;5;237m";

// --- Semantic theme (exported) ---
export const t = {
  reset: RESET,

  // Text formatting
  bold: BOLD,
  boldOff: BOLD_OFF,
  dim: DIM,
  italic: ITALIC,
  italicOff: ITALIC_OFF,
  underline: UNDERLINE,
  underlineOff: UNDERLINE_OFF,
  inverse: INVERSE,

  // Semantic colors
  accent: CYAN,         // interactive elements, selected items, code, links
  success: GREEN,       // completed tool calls, status indicators
  error: RED,           // errors, failures
  warn: YELLOW,         // warnings, plan mode
  muted: DIM,           // hints, secondary text, descriptions

  // Mode-specific
  modePlan: YELLOW,
  modeExecute: DARK_GREEN,

  // Backgrounds
  bgUser: BG_GRAY,      // user message background
} as const;
