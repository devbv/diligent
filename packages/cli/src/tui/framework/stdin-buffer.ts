/**
 * Splits batched raw input into individual key sequences.
 * Handles single characters, escape sequences, and Kitty protocol sequences.
 */
export class StdinBuffer {
  /** Split a raw input chunk into individual sequences */
  split(data: string): string[] {
    const sequences: string[] = [];
    let i = 0;

    while (i < data.length) {
      if (data[i] === "\x1b") {
        // Escape sequence
        const seq = this.readEscapeSequence(data, i);
        sequences.push(seq);
        i += seq.length;
      } else {
        // Single character (including control chars)
        sequences.push(data[i]);
        i++;
      }
    }

    return sequences;
  }

  private readEscapeSequence(data: string, start: number): string {
    // Just ESC alone or at end of data
    if (start + 1 >= data.length) {
      return data[start];
    }

    const next = data[start + 1];

    // CSI sequence: ESC [
    if (next === "[") {
      return this.readCSISequence(data, start);
    }

    // SS3 sequence: ESC O
    if (next === "O") {
      if (start + 2 < data.length) {
        return data.slice(start, start + 3);
      }
      return data.slice(start, start + 2);
    }

    // Alt+key: ESC + char
    return data.slice(start, start + 2);
  }

  private readCSISequence(data: string, start: number): string {
    // CSI: ESC [ followed by parameter bytes (0x30-0x3F), intermediate bytes (0x20-0x2F),
    // and a final byte (0x40-0x7E)
    let i = start + 2; // Skip ESC [

    // Read parameter bytes (digits, semicolons, question marks, etc.)
    while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) {
      i++;
    }

    // Read intermediate bytes
    while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) {
      i++;
    }

    // Read final byte
    if (i < data.length && data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e) {
      i++;
    }

    return data.slice(start, i);
  }
}
