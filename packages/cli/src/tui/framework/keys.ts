/** Named key identifiers */
export type KeyId =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "ctrl+c"
  | "ctrl+d"
  | "ctrl+l"
  | "ctrl+z"
  | "ctrl+a"
  | "ctrl+e"
  | "ctrl+k"
  | "ctrl+u"
  | "ctrl+w"
  | "ctrl+backspace"
  | "shift+enter"
  | string;

/** Legacy escape code mappings for each key */
const KEY_SEQUENCES: Record<string, string[]> = {
  enter: ["\r", "\n"],
  escape: ["\x1b"],
  tab: ["\t"],
  backspace: ["\x7f", "\b"],
  delete: ["\x1b[3~"],
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  left: ["\x1b[D", "\x1bOD"],
  right: ["\x1b[C", "\x1bOC"],
  home: ["\x1b[H", "\x1b[1~", "\x1bOH"],
  end: ["\x1b[F", "\x1b[4~", "\x1bOF"],
  pageup: ["\x1b[5~"],
  pagedown: ["\x1b[6~"],
  "ctrl+c": ["\x03"],
  "ctrl+d": ["\x04"],
  "ctrl+l": ["\x0c"],
  "ctrl+z": ["\x1a"],
  "ctrl+a": ["\x01"],
  "ctrl+e": ["\x05"],
  "ctrl+k": ["\x0b"],
  "ctrl+u": ["\x15"],
  "ctrl+w": ["\x17"],
  "ctrl+backspace": ["\x08"],
  "shift+enter": ["\x1b[13;2u"], // Kitty protocol
};

/** Kitty protocol key code mappings */
const KITTY_KEY_CODES: Record<string, number> = {
  enter: 13,
  escape: 27,
  tab: 9,
  backspace: 127,
  delete: 46,
  up: 65,
  down: 66,
  left: 68,
  right: 67,
  home: 72,
  end: 70,
  pageup: 53,
  pagedown: 54,
};

/** Parse a Kitty protocol escape sequence into structured key info */
export function parseKittyKey(data: string): { key: string; modifiers: number; eventType: number } | null {
  // Kitty format: CSI number ; modifiers:eventType u
  // Or: CSI number ; modifiers u
  const match = data.match(new RegExp(`^${String.fromCharCode(0x1b)}\\[(\\d+)(?:;(\\d+)(?::(\\d+))?)?u$`));
  if (!match) return null;

  const keyCode = Number.parseInt(match[1], 10);
  const modifiers = match[2] ? Number.parseInt(match[2], 10) - 1 : 0; // 1-based to 0-based
  const eventType = match[3] ? Number.parseInt(match[3], 10) : 1; // 1=press, 2=repeat, 3=release

  // Find key name from code
  let key = String.fromCharCode(keyCode);
  for (const [name, code] of Object.entries(KITTY_KEY_CODES)) {
    if (code === keyCode) {
      key = name;
      break;
    }
  }

  return { key, modifiers, eventType };
}

/** Check if raw input data matches a named key */
export function matchesKey(data: string, keyId: KeyId): boolean {
  // Check legacy sequences
  const sequences = KEY_SEQUENCES[keyId];
  if (sequences) {
    for (const seq of sequences) {
      if (data === seq) return true;
    }
  }

  // Check Kitty protocol
  const kitty = parseKittyKey(data);
  if (kitty && kitty.eventType !== 3) {
    // Not a release event
    const expectedCode = KITTY_KEY_CODES[keyId];
    if (expectedCode !== undefined && kitty.key === keyId && kitty.modifiers === 0) {
      return true;
    }

    // Check ctrl+ combinations
    if (keyId.startsWith("ctrl+")) {
      const baseKey = keyId.slice(5);
      if (kitty.modifiers === 4) {
        // Ctrl modifier
        if (baseKey.length === 1 && kitty.key === baseKey) return true;
        if (KITTY_KEY_CODES[baseKey] !== undefined && kitty.key === baseKey) return true;
      }
    }

    // Check shift+ combinations
    if (keyId.startsWith("shift+")) {
      const baseKey = keyId.slice(6);
      if (kitty.modifiers === 1) {
        // Shift modifier
        const expectedKeyCode = KITTY_KEY_CODES[baseKey];
        if (expectedKeyCode !== undefined && kitty.key === baseKey) return true;
      }
    }
  }

  return false;
}

/** Check if data represents a printable character */
export function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 32 && code !== 127;
}
