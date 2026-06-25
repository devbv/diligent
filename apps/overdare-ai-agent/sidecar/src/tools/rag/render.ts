import { z } from "zod";

type RenderBlock = Record<string, unknown>;

type ToolRenderPayload = {
  inputSummary?: string;
  outputSummary?: string;
  blocks: RenderBlock[];
};

interface RagResult {
  text: string;
  originFileUrl?: string;
  script?: string;
}

interface AssetResult {
  text: string;
  score: number;
  title: string;
  keywords: string[];
  assetId: string;
  assetType: string;
  categoryId: string;
  subCategoryId: string;
  price?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  sourceUrl?: string;
}

const AssetResultSchema = z.object({
  text: z.string(),
  score: z.number(),
  title: z.string(),
  keywords: z.array(z.string()),
  assetId: z.string(),
  assetType: z.string(),
  categoryId: z.string(),
  subCategoryId: z.string(),
  price: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  previewUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
});

interface DebugResult {
  text: string;
  score: number;
  title: string;
  symptom: string;
  causeClassification: string;
  verification: string;
  solution: string;
  overdareNotes: string;
  relatedCases: string[];
  caseId: string;
  category: string;
  symptomTags: string[];
  severity: string;
  genreTags: string[];
  overdareVersion: string;
  keywords: string[];
}

interface OriginFileResult {
  originFileUrl: string;
  content: string | null;
}

type ToolRenderBlock =
  | { type: "summary"; text: string; tone?: "default" | "success" | "warning" | "danger" | "info" }
  | { type: "text"; title?: string; text: string; isError?: boolean }
  | { type: "key_value"; title?: string; items: Array<{ key: string; value: string }> }
  | { type: "table"; title?: string; columns: string[]; rows: string[][] }
  | {
      type: "asset_gallery";
      title?: string;
      query?: string;
      items: Array<{
        id?: string;
        title: string;
        subtitle?: string;
        price?: string;
        thumbnailUrl?: string;
        previewUrl?: string;
        sourceUrl?: string;
        metadata?: Array<{ key: string; value: string }>;
      }>;
    }
  | { type: "file"; filePath: string; content?: string; offset?: number; limit?: number; isError?: boolean };

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortUrl(value: string): string {
  const normalized = value.replace(/^https?:\/\//, "");
  return normalized.length > 0 ? normalized : value;
}

function summarizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeSearchOutput(source: string, count: number): string {
  if (count === 0) return "No results found.";

  switch (source) {
    case "docs":
      return summarizeCount(count, "document match");
    case "code":
      return summarizeCount(count, "code match");
    case "assets":
      return summarizeCount(count, "asset");
    case "debug":
      return summarizeCount(count, "debug case");
    default:
      return summarizeCount(count, "result");
  }
}

function nonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readStringField(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function buildCodePreviewBlock(result: RagResult): ToolRenderBlock | undefined {
  const content = result.script?.trim() || result.text?.trim();
  if (!content) return undefined;
  return {
    type: "file",
    filePath: result.originFileUrl ?? "OVERDARE code result",
    content,
  };
}

function buildDocsPreviewBlock(result: RagResult): ToolRenderBlock | undefined {
  if (!nonEmpty(result.text)) return undefined;
  return {
    type: "text",
    title: "Top document match",
    text: result.text,
  };
}

export function normalizeAssetForRender(raw: Partial<AssetResult>): AssetResult {
  const rawRecord = raw as Record<string, unknown>;
  return {
    text: raw.text ?? "",
    score: raw.score ?? 0,
    title: raw.title ?? "(untitled)",
    keywords: raw.keywords ?? [],
    assetId: raw.assetId ?? "",
    assetType: raw.assetType ?? "(unknown)",
    categoryId: raw.categoryId ?? "(unknown)",
    subCategoryId: raw.subCategoryId ?? "(unknown)",
    price: readStringField(rawRecord, ["price", "priceText"]),
    thumbnailUrl: readStringField(rawRecord, [
      "thumbnailUrl",
      "thumbnail_url",
      "thumbnail",
      "imageUrl",
      "image_url",
      "image",
      "previewImageUrl",
    ]),
    previewUrl: readStringField(rawRecord, ["previewUrl", "preview_url", "assetUrl", "asset_url"]),
    sourceUrl: readStringField(rawRecord, ["sourceUrl", "source_url", "url", "marketplaceUrl"]),
  };
}

function buildAssetGalleryBlock(query: string, results: AssetResult[]): ToolRenderBlock | undefined {
  const items = results.slice(0, 8).map((result) => ({
    id: result.assetId || undefined,
    title: result.title,
    subtitle: result.assetType,
    price: result.price,
    thumbnailUrl: result.thumbnailUrl,
    previewUrl: result.previewUrl,
    sourceUrl: result.sourceUrl,
    metadata: [
      { key: "assetId", value: result.assetId },
      { key: "assetType", value: result.assetType },
      { key: "category", value: result.categoryId },
      { key: "subcategory", value: result.subCategoryId },
      { key: "score", value: String(result.score) },
    ].filter((item) => item.value.length > 0),
  }));

  if (items.length === 0) return undefined;

  return {
    type: "asset_gallery",
    title: "OVERDARE Assets",
    query,
    items,
  };
}

function normalizeDebugForRender(raw: Partial<DebugResult>): DebugResult {
  return {
    text: raw.text ?? "",
    score: raw.score ?? 0,
    title: raw.title ?? raw.symptom ?? "(untitled)",
    symptom: raw.symptom ?? "",
    causeClassification: raw.causeClassification ?? "",
    verification: raw.verification ?? "",
    solution: raw.solution ?? "",
    overdareNotes: raw.overdareNotes ?? "",
    relatedCases: raw.relatedCases ?? [],
    caseId: raw.caseId ?? "(unknown)",
    category: raw.category ?? "(unknown)",
    symptomTags: raw.symptomTags ?? [],
    severity: raw.severity ?? "(unknown)",
    genreTags: raw.genreTags ?? [],
    overdareVersion: raw.overdareVersion ?? "",
    keywords: raw.keywords ?? [],
  };
}

function buildDebugPreviewBlock(result: DebugResult): ToolRenderBlock[] {
  const blocks: ToolRenderBlock[] = [
    {
      type: "key_value",
      title: "Top debug case",
      items: [
        { key: "caseId", value: result.caseId },
        { key: "category", value: result.category },
        { key: "severity", value: result.severity },
        { key: "score", value: String(result.score) },
      ],
    },
  ];

  if (nonEmpty(result.symptom)) {
    blocks.push({ type: "text", title: "Symptom", text: result.symptom });
  }
  if (nonEmpty(result.causeClassification)) {
    blocks.push({ type: "text", title: "Cause", text: result.causeClassification });
  }
  if (nonEmpty(result.solution)) {
    blocks.push({ type: "text", title: "Solution", text: result.solution });
  }
  if (result.symptomTags.length > 0) {
    blocks.push({ type: "text", title: "Symptom tags", text: result.symptomTags.join(", ") });
  }

  return blocks;
}

export function buildSearchRender(args: { source: string; query: string }, results: RagResult[]): ToolRenderPayload {
  if (args.source === "debug") {
    const rawDebug = results as unknown as Partial<DebugResult>[];
    const debugResults = rawDebug.map(normalizeDebugForRender);
    const rows = debugResults
      .slice(0, 10)
      .map((entry) => [
        clip(entry.caseId, 12),
        clip(entry.title, 40),
        clip(entry.category, 12),
        clip(entry.severity, 8),
      ]);
    return {
      inputSummary: clip(`${args.source}: ${args.query}`, 100),
      outputSummary: summarizeSearchOutput(args.source, debugResults.length),
      blocks: [
        {
          type: "key_value",
          title: "OVERDARE search",
          items: [
            { key: "source", value: args.source },
            { key: "query", value: args.query },
            { key: "results", value: String(debugResults.length) },
          ],
        },
        ...(debugResults.length === 0
          ? [{ type: "summary" as const, text: "No results found.", tone: "warning" as const }]
          : []),
        ...(rows.length > 0
          ? [
              {
                type: "table" as const,
                title: "Debug cases",
                columns: ["Case", "Symptom", "Category", "Severity"],
                rows,
              },
            ]
          : []),
        ...(debugResults[0] ? buildDebugPreviewBlock(debugResults[0]) : []),
      ],
    };
  }

  if (args.source === "assets") {
    const rawAssets = results as unknown as Partial<AssetResult>[];
    const assetResults = rawAssets.map((raw) => {
      const parsed = AssetResultSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[overdaresearch] asset schema drift", {
          assetId: raw.assetId ?? "(unknown)",
          issues: parsed.error.issues,
        });
      }
      return normalizeAssetForRender(raw);
    });
    const galleryBlock = buildAssetGalleryBlock(args.query, assetResults);
    return {
      inputSummary: clip(`${args.source}: ${args.query}`, 100),
      outputSummary: summarizeSearchOutput(args.source, assetResults.length),
      blocks: [
        {
          type: "key_value",
          title: "OVERDARE search",
          items: [
            { key: "source", value: args.source },
            { key: "query", value: args.query },
            { key: "results", value: String(assetResults.length) },
          ],
        },
        ...(assetResults.length === 0
          ? [{ type: "summary" as const, text: "No results found.", tone: "warning" as const }]
          : []),
        ...(galleryBlock ? [galleryBlock] : []),
      ],
    };
  }

  const rows = results.slice(0, 10).map((entry) => {
    const snippet = args.source === "code" ? entry.script?.trim() || entry.text || "" : (entry.text ?? "");
    return [clip(snippet, 96), clip(entry.originFileUrl ?? "", 56)];
  });
  const previewBlock =
    args.source === "code"
      ? buildCodePreviewBlock(results[0] ?? { text: "" })
      : args.source === "docs"
        ? buildDocsPreviewBlock(results[0] ?? { text: "" })
        : undefined;
  return {
    inputSummary: clip(`${args.source}: ${args.query}`, 100),
    outputSummary: summarizeSearchOutput(args.source, results.length),
    blocks: [
      {
        type: "key_value",
        title: "OVERDARE search",
        items: [
          { key: "source", value: args.source },
          { key: "query", value: args.query },
          { key: "results", value: String(results.length) },
        ],
      },
      ...(results.length === 0
        ? [{ type: "summary" as const, text: "No results found.", tone: "warning" as const }]
        : []),
      ...(rows.length > 0 ? [{ type: "table" as const, title: "Matches", columns: ["Snippet", "Origin"], rows }] : []),
      ...(previewBlock ? [previewBlock] : []),
    ],
  };
}

export function buildOriginFileRender(
  action: string,
  requestedUrls: string[],
  files: OriginFileResult[],
): ToolRenderPayload {
  const loaded = files.filter((entry) => typeof entry.content === "string");
  const rows = files
    .slice(0, 10)
    .map((entry) => [
      clip(shortUrl(entry.originFileUrl), 56),
      entry.content ? `${entry.content.split("\n").length} lines` : "missing",
    ]);
  const blocks: ToolRenderPayload["blocks"] = [
    {
      type: "key_value",
      title: "OVERDARE deep search",
      items: [
        { key: "action", value: action },
        { key: "requested", value: String(requestedUrls.length) },
        { key: "loaded", value: String(loaded.length) },
      ],
    },
  ];

  if (rows.length > 0) {
    blocks.push({ type: "table", title: "Fetched files", columns: ["Origin", "Status"], rows });
  }

  const firstLoaded = loaded[0];
  if (firstLoaded?.content) {
    blocks.push({ type: "file", filePath: firstLoaded.originFileUrl, content: firstLoaded.content });
  }

  return {
    inputSummary: `${action} (${requestedUrls.length} URL${requestedUrls.length === 1 ? "" : "s"})`,
    outputSummary: summarizeCount(loaded.length, "file"),
    blocks,
  };
}
