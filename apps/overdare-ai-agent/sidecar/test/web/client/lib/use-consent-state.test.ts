// @summary Tests persistent local acknowledgement of the first-run AI-data notice.

import { describe, expect, test } from "bun:test";
import {
  FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY,
  readFirstRunNoticeAcknowledged,
  writeFirstRunNoticeAcknowledged,
} from "../../../../src/web/client/lib/use-consent-state";

function memoryStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> & { value?: string } {
  return {
    value: initial,
    getItem(key) {
      expect(key).toBe(FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY);
      return this.value ?? null;
    },
    setItem(key, value) {
      expect(key).toBe(FIRST_RUN_NOTICE_ACKNOWLEDGED_KEY);
      this.value = value;
    },
  };
}

describe("first-run AI-data notice acknowledgement", () => {
  test("persists acknowledgement independently from the gateway consent state", () => {
    const storage = memoryStorage();

    expect(readFirstRunNoticeAcknowledged(storage)).toBe(false);
    writeFirstRunNoticeAcknowledged(storage);
    expect(readFirstRunNoticeAcknowledged(storage)).toBe(true);
  });

  test("treats unavailable or blocked browser storage as unacknowledged", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    };

    expect(readFirstRunNoticeAcknowledged(undefined)).toBe(false);
    expect(readFirstRunNoticeAcknowledged(blockedStorage)).toBe(false);
    expect(() => writeFirstRunNoticeAcknowledged(blockedStorage)).not.toThrow();
  });
});
