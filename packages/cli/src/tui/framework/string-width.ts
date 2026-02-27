/**
 * Get the terminal display width of a Unicode code point.
 * CJK / Hangul / fullwidth characters occupy 2 columns; most others occupy 1.
 */
export function charDisplayWidth(codePoint: number): number {
  // Hangul Jamo (initial consonants — always wide in terminals)
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
  if (codePoint >= 0x11a3 && codePoint <= 0x11a7) return 2;
  if (codePoint >= 0x11fa && codePoint <= 0x11ff) return 2;
  // CJK Radicals, Kangxi Radicals, Ideographic Description, CJK Symbols
  if (codePoint >= 0x2e80 && codePoint <= 0x303e) return 2;
  // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, Kanbun, etc.
  if (codePoint >= 0x3040 && codePoint <= 0x33bf) return 2;
  // CJK Unified Ideographs Extension A
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 2;
  // CJK Unified Ideographs
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 2;
  // Hangul Syllables (가–힣)
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 2;
  // CJK Compatibility Ideographs
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
  // Vertical / Small / Compatibility Forms
  if (codePoint >= 0xfe10 && codePoint <= 0xfe6f) return 2;
  // Fullwidth Forms (！through ～)
  if (codePoint >= 0xff01 && codePoint <= 0xff60) return 2;
  // Fullwidth currency / symbol variants
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  // CJK Unified Ideographs Extension B–F + Supplementary
  if (codePoint >= 0x20000 && codePoint <= 0x2fa1f) return 2;
  return 1;
}

/**
 * Measure the terminal display width of a plain string (no ANSI codes).
 * Iterates by code point so surrogate pairs are handled correctly.
 */
export function displayWidth(str: string): number {
  // Fast path: pure ASCII
  let allAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7e || str.charCodeAt(i) < 0x20) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) return str.length;

  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      width += charDisplayWidth(cp);
    }
  }
  return width;
}

/**
 * Slice characters from the start of a string that fit within `maxWidth`
 * terminal columns.  Returns the substring.
 */
export function sliceToFitWidth(str: string, maxWidth: number): string {
  let width = 0;
  let byteEnd = 0;
  for (const ch of str) {
    const cw = charDisplayWidth(ch.codePointAt(0)!);
    if (width + cw > maxWidth) break;
    width += cw;
    byteEnd += ch.length; // handles surrogate pairs
  }
  return str.slice(0, byteEnd);
}

/**
 * Slice characters from the end of a string that fit within `maxWidth`
 * terminal columns.  Returns the substring.
 */
export function sliceEndToFitWidth(str: string, maxWidth: number): string {
  const chars = [...str]; // split into code points
  let width = 0;
  let startIdx = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charDisplayWidth(chars[i].codePointAt(0)!);
    if (width + cw > maxWidth) break;
    width += cw;
    startIdx = i;
  }
  return chars.slice(startIdx).join("");
}
