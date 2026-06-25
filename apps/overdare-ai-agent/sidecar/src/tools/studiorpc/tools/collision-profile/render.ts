// @summary Render payload builders for collision channel/profile tools.

import type { ToolRenderPayload } from "../../types";

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rowsFromChannels(channels: unknown): string[][] {
  if (!Array.isArray(channels)) return [];
  return channels.flatMap((channel) => {
    if (typeof channel !== "object" || channel === null || Array.isArray(channel)) return [];
    const entry = channel as Record<string, unknown>;
    return [
      [
        readString(entry.channel),
        readString(entry.name),
        readBoolean(entry.bTraceType),
        readString(entry.defaultResponse),
      ],
    ];
  });
}

function rowsFromProfiles(profiles: unknown): string[][] {
  if (!Array.isArray(profiles)) return [];
  return profiles.flatMap((profile) => {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return [];
    const entry = profile as Record<string, unknown>;
    return [
      [
        readString(entry.name),
        readString(entry.objectTypeName),
        readString(entry.collisionEnabled),
        String(Array.isArray(entry.customResponses) ? entry.customResponses.length : 0),
      ],
    ];
  });
}

export function buildCollisionChannelsRender(payload: Record<string, unknown>): ToolRenderPayload {
  const defaultCount = readNumber(payload.defaultChannelCount);
  const customCount = readNumber(payload.customChannelCount);
  const totalCount = readNumber(payload.totalChannelCount);
  const defaultRows = rowsFromChannels(payload.defaultChannels);
  const customRows = rowsFromChannels(payload.customChannels);

  return {
    inputSummary: "list collision channels",
    outputSummary: `${totalCount} channels (${customCount} custom)`,
    blocks: [
      {
        type: "key_value",
        title: "Collision channels",
        items: [
          { key: "total", value: String(totalCount) },
          { key: "default", value: String(defaultCount) },
          { key: "custom", value: String(customCount) },
        ],
      },
      {
        type: "table",
        title: "Default channels",
        columns: ["Channel", "Name", "Trace", "Default response"],
        rows: defaultRows,
      },
      ...(customRows.length > 0
        ? [
            {
              type: "table" as const,
              title: "Custom channels",
              columns: ["Channel", "Name", "Trace", "Default response"],
              rows: customRows,
            },
          ]
        : [{ type: "summary" as const, text: "No custom collision channels.", tone: "info" as const }]),
    ],
  };
}

export function buildCollisionProfilesRender(payload: Record<string, unknown>): ToolRenderPayload {
  const defaultCount = readNumber(payload.defaultProfileCount);
  const customCount = readNumber(payload.customProfileCount);
  const totalCount = readNumber(payload.totalProfileCount);
  const defaultRows = rowsFromProfiles(payload.defaultProfiles);
  const customRows = rowsFromProfiles(payload.customProfiles);

  return {
    inputSummary: "list collision profiles",
    outputSummary: `${totalCount} profiles (${customCount} custom)`,
    blocks: [
      {
        type: "key_value",
        title: "Collision profiles",
        items: [
          { key: "total", value: String(totalCount) },
          { key: "default", value: String(defaultCount) },
          { key: "custom", value: String(customCount) },
        ],
      },
      {
        type: "table",
        title: "Default profiles",
        columns: ["Name", "Object type", "Enabled", "Responses"],
        rows: defaultRows,
      },
      ...(customRows.length > 0
        ? [
            {
              type: "table" as const,
              title: "Custom profiles",
              columns: ["Name", "Object type", "Enabled", "Responses"],
              rows: customRows,
            },
          ]
        : [{ type: "summary" as const, text: "No custom collision profiles.", tone: "info" as const }]),
    ],
  };
}
