import { describe, expect, test } from "bun:test";
import {
  parseContextFromText,
  prependContextToMessage,
  serializeContextItemsForPrompt,
} from "../../../../src/web/client/lib/agent-native-bridge";

describe("serializeContextItemsForPrompt", () => {
  test("returns empty string for empty items", () => {
    expect(serializeContextItemsForPrompt([])).toBe("");
  });

  test("serializes instance items", () => {
    const result = serializeContextItemsForPrompt([
      { kind: "instance", source: "studiorpc", GUID: "abc-1", ClassType: "Part", Name: "MyPart" },
    ]);
    expect(result).toContain("<AttachedContext>");
    expect(result).toContain("- Instance: Name=MyPart; ClassType=Part; GUID=abc-1");
    expect(result).toContain("</AttachedContext>");
  });

  test("serializes file items with selection", () => {
    const result = serializeContextItemsForPrompt([
      {
        kind: "file",
        source: "vscode",
        uri: "file:///workspace/app.ts",
        Name: "app.ts",
        languageId: "typescript",
        selection: { startLine: 9, startCharacter: 0, endLine: 19, endCharacter: 4 },
      },
    ]);
    expect(result).toContain(
      "- File: Name=app.ts; URI=file:///workspace/app.ts; Language=typescript; Selection=10:1-20:5",
    );
  });
});

describe("parseContextFromText", () => {
  test("returns empty contextItems for plain text", () => {
    const result = parseContextFromText("hello world");
    expect(result.contextItems).toEqual([]);
    expect(result.remainingText).toBe("hello world");
  });

  test("parses single instance item and strips block from text", () => {
    const input = "<AttachedContext>\n- Instance: Name=MyPart; ClassType=Part; GUID=abc-1\n</AttachedContext>\nhello";
    const result = parseContextFromText(input);
    expect(result.contextItems).toEqual([
      { kind: "instance", source: "studiorpc", GUID: "abc-1", ClassType: "Part", Name: "MyPart" },
    ]);
    expect(result.remainingText).toBe("hello");
  });

  test("parses multiple instance items", () => {
    const input =
      "<AttachedContext>\n- Instance: Name=MyPart; ClassType=Part; GUID=abc-1\n- Instance: Name=GameManager; ClassType=Script; GUID=abc-2\n</AttachedContext>\n";
    const result = parseContextFromText(input);
    expect(result.contextItems).toHaveLength(2);
    expect(result.contextItems[0]).toMatchObject({ Name: "MyPart", GUID: "abc-1" });
    expect(result.contextItems[1]).toMatchObject({ Name: "GameManager", GUID: "abc-2" });
    expect(result.remainingText).toBe("");
  });

  test("parses file item without selection", () => {
    const input =
      "<AttachedContext>\n- File: Name=app.ts; URI=file:///workspace/app.ts; Language=typescript\n</AttachedContext>\ndo something";
    const result = parseContextFromText(input);
    expect(result.contextItems).toEqual([
      {
        kind: "file",
        source: "vscode",
        Name: "app.ts",
        uri: "file:///workspace/app.ts",
        languageId: "typescript",
        selection: undefined,
      },
    ]);
    expect(result.remainingText).toBe("do something");
  });

  test("parses file item with selection and restores 0-indexed line/char", () => {
    const input =
      "<AttachedContext>\n- File: Name=app.ts; URI=file:///workspace/app.ts; Language=typescript; Selection=10:1-20:5\n</AttachedContext>\n";
    const result = parseContextFromText(input);
    expect(result.contextItems[0]).toMatchObject({
      kind: "file",
      selection: { startLine: 9, startCharacter: 0, endLine: 19, endCharacter: 4 },
    });
  });

  test("returns empty contextItems when block is absent", () => {
    const result = parseContextFromText("no context here");
    expect(result.contextItems).toEqual([]);
    expect(result.remainingText).toBe("no context here");
  });
});

describe("parseContextFromText round-trip", () => {
  test("serialize then parse restores original items and text", () => {
    const items = [
      { kind: "instance" as const, source: "studiorpc" as const, GUID: "g1", ClassType: "Part", Name: "P1" },
      {
        kind: "file" as const,
        source: "vscode" as const,
        uri: "file:///foo.ts",
        Name: "foo.ts",
        languageId: "typescript",
        selection: { startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 9 },
      },
    ];
    const originalText = "please do this";
    const serialized = prependContextToMessage(originalText, items);
    const parsed = parseContextFromText(serialized);
    expect(parsed.remainingText).toBe(originalText);
    expect(parsed.contextItems).toHaveLength(2);
    expect(parsed.contextItems[0]).toMatchObject({ kind: "instance", GUID: "g1", Name: "P1" });
    expect(parsed.contextItems[1]).toMatchObject({ kind: "file", uri: "file:///foo.ts" });
    const file = parsed.contextItems[1];
    if (file.kind === "file") {
      expect(file.selection).toEqual({ startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 9 });
    }
  });
});
