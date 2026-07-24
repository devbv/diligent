// @summary Client-local AgentNativeBridge types, window API, reducer helpers, and prompt serialization for host-injected context items

export type AgentContextItem = StudioRpcInstanceContextItem | VsCodeFileContextItem;

export type AgentNativeBridgeInputItem =
  | {
      GUID: string;
      ClassType: string;
      Name: string;
    }
  | {
      uri: string;
      Name: string;
      languageId?: string;
      selection?: {
        startLine: number;
        startCharacter: number;
        endLine: number;
        endCharacter: number;
      };
    };

export interface StudioRpcInstanceContextItem {
  kind: "instance";
  source: "studiorpc";
  GUID: string;
  ClassType: string;
  Name: string;
}

export interface VsCodeFileContextItem {
  kind: "file";
  source: "vscode";
  uri: string;
  Name: string;
  languageId?: string;
  selection?: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export interface AgentNativeBridgeApi {
  updateContextItems: (items: unknown[]) => void;
}

declare global {
  interface Window {
    AgentNativeBridge?: AgentNativeBridgeApi;
    __DILIGENT_AGENT_NATIVE_BRIDGE_MOCK__?: {
      addStudioInstance: (item?: Partial<StudioRpcInstanceContextItem>) => void;
      addVsCodeFile: (item?: Partial<VsCodeFileContextItem>) => void;
      clear: () => void;
    };
  }
}

export function normalizeAgentContextItem(value: unknown): AgentContextItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.GUID === "string" && typeof record.ClassType === "string" && typeof record.Name === "string") {
    return {
      kind: "instance",
      source: "studiorpc",
      GUID: record.GUID,
      ClassType: record.ClassType,
      Name: record.Name,
    };
  }
  if (typeof record.uri === "string" && typeof record.Name === "string") {
    if (record.languageId !== undefined && typeof record.languageId !== "string") {
      return null;
    }
    if (record.selection !== undefined && !isSelection(record.selection)) {
      return null;
    }
    return {
      kind: "file",
      source: "vscode",
      uri: record.uri,
      Name: record.Name,
      languageId: record.languageId as string | undefined,
      selection: record.selection as VsCodeFileContextItem["selection"],
    };
  }
  return null;
}

export function isAgentContextItem(value: unknown): value is AgentContextItem {
  return normalizeAgentContextItem(value) !== null;
}

function isSelection(value: unknown): value is VsCodeFileContextItem["selection"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const selection = value as Record<string, unknown>;
  return (
    typeof selection.startLine === "number" &&
    typeof selection.startCharacter === "number" &&
    typeof selection.endLine === "number" &&
    typeof selection.endCharacter === "number"
  );
}

export function normalizeAgentContextItems(items: unknown[]): AgentContextItem[] {
  const map = new Map<string, AgentContextItem>();
  for (const item of items) {
    const normalized = normalizeAgentContextItem(item);
    if (!normalized) {
      continue;
    }
    map.set(getAgentContextItemKey(normalized), normalized);
  }
  return Array.from(map.values());
}

export function mergeAgentContextItems(current: AgentContextItem[], incoming: unknown[]): AgentContextItem[] {
  const map = new Map(current.map((item) => [getAgentContextItemKey(item), item]));
  for (const item of normalizeAgentContextItems(incoming)) {
    map.set(getAgentContextItemKey(item), item);
  }
  return Array.from(map.values());
}

export function getAgentContextItemKey(item: AgentContextItem): string {
  if (item.kind === "instance") {
    return `instance:${item.GUID}`;
  }
  if (item.selection) {
    return `file:${item.uri}:${item.selection.startLine}:${item.selection.startCharacter}:${item.selection.endLine}:${item.selection.endCharacter}`;
  }
  return `file:${item.uri}`;
}

export function formatAgentContextItemLabel(item: AgentContextItem): string {
  if (item.kind === "instance") {
    return `${item.Name} (${item.ClassType})`;
  }
  return item.languageId ? `${item.Name} (${item.languageId})` : item.Name;
}

export function serializeContextItemsForPrompt(items: AgentContextItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const lines = items.map((item) => {
    if (item.kind === "instance") {
      return `- Instance: Name=${item.Name}; ClassType=${item.ClassType}; GUID=${item.GUID}`;
    }
    const language = item.languageId ? `; Language=${item.languageId}` : "";
    const selection = item.selection
      ? `; Selection=${item.selection.startLine + 1}:${item.selection.startCharacter + 1}-${item.selection.endLine + 1}:${item.selection.endCharacter + 1}`
      : "";
    return `- File: Name=${item.Name}; URI=${item.uri}${language}${selection}`;
  });
  return [`<AttachedContext>`, ...lines, `</AttachedContext>`, ``].join("\n");
}

export function prependContextToMessage(message: string, items: AgentContextItem[]): string {
  const serialized = serializeContextItemsForPrompt(items);
  if (!serialized) return message;
  const trimmed = message.trim();
  if (!trimmed) return serialized.trimEnd();
  return `${serialized}${trimmed}`;
}

export interface ParsedContextText {
  contextItems: AgentContextItem[];
  remainingText: string;
}

function parseInstanceLine(line: string): AgentContextItem | null {
  const match = line.match(/^- Instance: Name=(.+?); ClassType=(.+?); GUID=(.+)$/);
  if (!match) return null;
  return { kind: "instance", source: "studiorpc", Name: match[1], ClassType: match[2], GUID: match[3] };
}

function parseSelectionString(
  raw: string,
): { startLine: number; startCharacter: number; endLine: number; endCharacter: number } | undefined {
  const m = raw.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!m) return undefined;
  return {
    startLine: parseInt(m[1], 10) - 1,
    startCharacter: parseInt(m[2], 10) - 1,
    endLine: parseInt(m[3], 10) - 1,
    endCharacter: parseInt(m[4], 10) - 1,
  };
}

function parseFileLine(line: string): AgentContextItem | null {
  const match = line.match(/^- File: Name=(.+?); URI=(.+?)(?:; Language=([^;]+?))?(?:; Selection=([^;]+))?$/);
  if (!match) return null;
  return {
    kind: "file",
    source: "vscode",
    Name: match[1],
    uri: match[2],
    languageId: match[3],
    selection: match[4] ? parseSelectionString(match[4]) : undefined,
  };
}

export function parseContextFromText(text: string): ParsedContextText {
  const blockMatch = text.match(/^<AttachedContext>\n([\s\S]*?)\n<\/AttachedContext>\n?/);
  if (!blockMatch) return { contextItems: [], remainingText: text };
  const contextItems: AgentContextItem[] = [];
  for (const line of blockMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = parseInstanceLine(trimmed) ?? parseFileLine(trimmed);
    if (item) contextItems.push(item);
  }
  return { contextItems, remainingText: text.slice(blockMatch[0].length) };
}

export function createAgentNativeBridge(handlers: {
  updateContextItems: (items: AgentContextItem[]) => void;
}): AgentNativeBridgeApi {
  return {
    updateContextItems(items: unknown[]) {
      handlers.updateContextItems(normalizeAgentContextItems(items));
    },
  };
}

export function installAgentNativeBridgeMock(windowObject: Window): void {
  windowObject.__DILIGENT_AGENT_NATIVE_BRIDGE_MOCK__ = {
    addStudioInstance(item = {}) {
      windowObject.AgentNativeBridge?.updateContextItems([
        {
          kind: "instance",
          source: "studiorpc",
          GUID: item.GUID ?? `mock-guid-${Date.now()}`,
          ClassType: item.ClassType ?? "Part",
          Name: item.Name ?? "MockSelection",
        },
      ]);
    },
    addVsCodeFile(item = {}) {
      windowObject.AgentNativeBridge?.updateContextItems([
        {
          kind: "file",
          source: "vscode",
          uri: item.uri ?? "file:///workspace/mock.ts",
          Name: item.Name ?? "mock.ts",
          languageId: item.languageId ?? "typescript",
          selection: item.selection,
        },
      ]);
    },
    clear() {
      windowObject.AgentNativeBridge?.updateContextItems([]);
    },
  };
}
