// @summary Tests for session ID and entry ID generation
import { describe, expect, it } from "bun:test";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@diligent/runtime/session";
import { generateEntryId, generateSessionId, SESSION_VERSION } from "@diligent/runtime/session";

describe("generateEntryId", () => {
  it("returns 8-char hex string", () => {
    const id = generateEntryId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEntryId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSessionId", () => {
  it("contains timestamp prefix", () => {
    const id = generateSessionId();
    // Format: YYYYMMDDHHmmssSSSCCC-random
    expect(id).toMatch(/^\d{20}-[0-9a-f]{6}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe("Session entry serialization roundtrip", () => {
  it("SessionHeader roundtrips", () => {
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: "20260225100000-abc123",
      timestamp: "2026-02-25T10:00:00.000Z",
      cwd: "/project",
    };
    expect(JSON.parse(JSON.stringify(header))).toEqual(header);
  });

  it("SessionMessageEntry roundtrips", () => {
    const entry: SessionMessageEntry = {
      type: "message",
      id: "abcdef01",
      parentId: null,
      timestamp: "2026-02-25T10:00:00.000Z",
      message: { role: "user", content: "hello", timestamp: 1708900000000 },
    };
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it("All SessionEntry variants roundtrip", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-02-25T10:00:00.000Z",
        message: { role: "user", content: "hi", timestamp: 1708900000000 },
      },
      {
        type: "model_change",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-02-25T10:00:01.000Z",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      },
      {
        type: "session_info",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-02-25T10:00:02.000Z",
        name: "Test session",
      },
      {
        type: "effort_change",
        id: "a4",
        parentId: "a3",
        timestamp: "2026-02-25T10:00:03.000Z",
        effort: "medium",
        changedBy: "command",
      },
    ];
    for (const entry of entries) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    }
  });
});
