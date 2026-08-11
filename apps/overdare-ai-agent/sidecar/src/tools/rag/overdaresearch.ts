import type { ToolContext, ToolResult } from "@diligent/core/tool-contract";
import { type RuntimeToolHost, requestToolApproval, requestToolUserInput } from "@diligent/runtime";
import { z } from "zod";
import { buildSearchRender, normalizeAssetForRender } from "./render";

const BASE_URL = "https://aiguide.overdare.com";
const TIMEOUT_MS = 10_000;

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
}

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

interface VfxResult {
  text: string;
  score: number;
  title: string;
  docType: "vfx_preset" | "recipe_template" | "vfx_source";
  docId: string;
  keywords: string[];
  // vfx_preset only: preset resource name (e.g. "VFX_UGC_Muzzle_01"), feeds VFXPreset.PresetName
  presetName?: string;
  // vfx_preset (primary category) and recipe_template
  category?: string;
  // recipe_template only
  elements?: string[];
  sources?: string[];
  patterns?: string[];
  // vfx_source only
  layer?: string;
  spawnType?: string;
  element?: string;
  resourceName?: string;
}

type AnyResult = RagResult | AssetResult | DebugResult | VfxResult;

interface RagResponse {
  results: AnyResult[];
  totalCount: number;
}

function isAssetResult(result: AnyResult): result is AssetResult {
  return "assetId" in result;
}

function isDebugResult(result: AnyResult): result is DebugResult {
  return "caseId" in result;
}

function isVfxResult(result: AnyResult): result is VfxResult {
  return "docType" in result;
}

function normalizeVfxResult(result: Partial<VfxResult>): Partial<VfxResult> {
  return {
    text: result.text,
    score: result.score,
    title: result.title,
    docType: result.docType,
    docId: result.docId,
    keywords: result.keywords,
    presetName: result.presetName,
    category: result.category,
    elements: result.elements,
    sources: result.sources,
    patterns: result.patterns,
    layer: result.layer,
    spawnType: result.spawnType,
    element: result.element,
    resourceName: result.resourceName,
  };
}

function normalizeAssetResult(result: Partial<AssetResult>): Partial<AssetResult> {
  return {
    text: result.text,
    score: result.score,
    title: result.title,
    keywords: result.keywords,
    assetId: result.assetId,
    assetType: result.assetType,
    categoryId: result.categoryId,
    subCategoryId: result.subCategoryId,
  };
}

function normalizeDebugResult(result: Partial<DebugResult>): Partial<DebugResult> {
  return {
    text: result.text,
    score: result.score,
    title: result.title,
    symptom: result.symptom,
    causeClassification: result.causeClassification,
    verification: result.verification,
    solution: result.solution,
    overdareNotes: result.overdareNotes,
    relatedCases: result.relatedCases,
    caseId: result.caseId,
    category: result.category,
    symptomTags: result.symptomTags,
    severity: result.severity,
    genreTags: result.genreTags,
    overdareVersion: result.overdareVersion,
    keywords: result.keywords,
  };
}

export const name = "overdaresearch";

export const description = `Searches OVERDARE documentation, code examples, assets, and debug cases using RAG.
Use this tool to find relevant OVERDARE API references, guides, code examples, Lua scripts, asset metadata, and debugging cases.

When to use each source:
  - Default topK by source: docs=4, code=4, assets=8, debug=5, vfx=3; only increase if results are insufficient
  - "docs": API references, conceptual guides, configuration details, service descriptions
  - "code": Working Lua implementation examples, proven patterns, real script snippets
  - "assets": Asset catalog search returning asset metadata such as title, keywords, assetId, assetType, categoryId, and subCategoryId
  - "debug": Debugging-case knowledge base (symptom → cause → solution). Each result includes symptom, causeClassification, solution, and caseId. Use when diagnosing a bug or unexpected behavior — describe the symptom in natural language.
  - "vfx": VFX knowledge base for effect requests, in three units: presets (docType=vfx_preset, ready-made named effects with presetName for VFXPreset creation), recipe templates (docType=recipe_template, full doc including an Original Payload JSON to copy and adapt), and VFX source catalog entries (docType=vfx_source, with layer/spawnType/element/resourceName for composing or editing VFXRecipe layers). Query by desired element, mood, or pattern (e.g. "fire explosion burst"). Narrow with vfxDocTypes when a specific unit is needed — presets dominate unfiltered results. Results carry the full doc text — no second fetch needed.
  - When writing or modifying code, search BOTH docs and code in parallel (two calls: one for docs, one for code) to get API shape + implementation patterns simultaneously

Query tips:
  - Provide a clear, specific RAG-friendly query describing what you want to find
  - Never include "OVERDARE" in query — all content is already scoped to OVERDARE
  - When querying for docs, do not include keywords like "doc" or "documentation" in the query — the source already targets the documentation store
  - When querying for code, do not include keywords like "Lua", "example", or "script" in the query — the source already targets the Lua code store
  - When querying for assets, use short noun-based queries such as item names, themes, categories, or use cases
  - When querying for debug, describe the symptom in natural language (e.g. "black screen with invisible buttons"); narrow with debugCaseFilter (category/severity/caseId exact match, symptomTags/genreTags match-any). overdareVersion filtering is NOT supported.`;

export const parameters = z.object({
  query: z.string().describe("Search query for OVERDARE (English only)"),
  source: z
    .enum(["docs", "code", "assets", "debug", "vfx"])
    .describe(
      "docs = API references and guides. code = working Lua implementation examples and patterns. assets = asset catalog search with asset metadata fields. debug = debugging cases (symptom → cause → solution). vfx = VFX presets, recipe templates, and source catalog for effect requests.",
    ),
  topK: z.number().int().min(1).max(10).describe("Number of results to return"),
  selectable: z
    .boolean()
    .default(true)
    .describe(
      "Assets only (default true). When 2+ assets match, the user is asked to pick one and the chosen assetId is returned; exactly 1 match auto-selects; 0 matches returns not-found. Set false ONLY for internal/informational asset lookups where you must read the results yourself (e.g. choosing UI element assets while generating an interface); never set false to pick a placement asset on the user's behalf.",
    ),
  vfxDocTypes: z
    .array(z.enum(["vfx_preset", "recipe_template", "vfx_source"]))
    .optional()
    .describe(
      'Only used when source=vfx. Restrict results to these doc types (OR); omit to search all three. Use ["recipe_template"] or ["vfx_source"] when escalating past presets — the preset corpus is much larger and dominates unfiltered results.',
    ),
  debugCaseFilter: z
    .object({
      caseId: z.string().optional().describe("Exact match on case ID"),
      category: z.string().optional().describe("Exact match on category (ui, script, 3d)"),
      severity: z.string().optional().describe("Exact match on severity (low/medium/high)"),
      symptomTags: z.array(z.string()).optional().describe("Match cases having ANY of these symptom tags (OR)"),
      genreTags: z.array(z.string()).optional().describe("Match cases having ANY of these genre tags (OR)"),
    })
    .optional()
    .describe(
      "Only used when source=debug. Fields combine with AND; omitted fields are not constrained. overdareVersion filtering is NOT supported.",
    ),
});

type Params = z.infer<typeof parameters>;

// Assets that skip the picker and auto-select the top-scored match, like the
// pre-picker behavior. assetType and categoryId are orthogonal axes in the RAG
// data (values verified against the live /api/chat/rag response), and AUDIO /
// ANIMATION appear on BOTH axes, so each is checked on both to catch every case:
//   - assetType=MODEL, categoryId=ANIMATION (e.g. BasicWalkAnimations)
//   - assetType=ANIMATION, categoryId=GAMEPLAY (e.g. flip jump)
//   - ACTION_SEQUENCE is an assetType that spans categories (EFFECTS, WEAPON, …).
// Compared case-insensitively.
const AUTO_SELECT_TYPES = new Set(["AUDIO", "ANIMATION", "ACTION_SEQUENCE"]);
const AUTO_SELECT_CATEGORIES = new Set(["AUDIO", "ANIMATION", "EFFECTS", "UI_ELEMENTS"]);

function shouldAutoSelect(asset: Partial<AssetResult>): boolean {
  return (
    AUTO_SELECT_TYPES.has((asset.assetType ?? "").trim().toUpperCase()) ||
    AUTO_SELECT_CATEGORIES.has((asset.categoryId ?? "").trim().toUpperCase())
  );
}

function autoSelectResult(raw: Partial<AssetResult>, resultCount: number): ToolResult {
  const only = normalizeAssetForRender(raw);
  return {
    output: `Selected asset: ${only.title} (assetId: ${only.assetId})`,
    metadata: { resultCount, assetId: only.assetId },
  };
}

async function selectAsset(
  host: RuntimeToolHost | undefined,
  query: string,
  rawAssets: Array<Partial<AssetResult>>,
): Promise<string> {
  const normalized = rawAssets.map(normalizeAssetForRender);
  const response = await requestToolUserInput(host, {
    questions: [
      {
        id: "asset",
        header: "Asset",
        question: `Pick an asset for "${query}"`,
        display: "asset",
        options: normalized.map((a) => ({
          label: a.title,
          description: a.price ? `${a.assetType} · ${a.price}` : a.assetType,
          value: a.assetId,
          asset: {
            thumbnailUrl: a.thumbnailUrl,
            previewUrl: a.previewUrl,
            price: a.price,
            subtitle: a.assetType,
          },
        })),
      },
    ],
  });

  const answer = response?.answers.asset;
  const chosen = Array.isArray(answer) ? answer[0] : answer;
  if (!chosen || chosen.trim().length === 0) {
    return "[Cancelled by user]";
  }
  const match = normalized.find((a) => a.assetId === chosen);
  return match ? `Selected asset: ${match.title} (assetId: ${match.assetId})` : `Selected assetId: ${chosen}`;
}

export async function execute(args: Params, _ctx: ToolContext, host?: RuntimeToolHost): Promise<ToolResult> {
  const approval = await requestToolApproval(host, {
    permission: "execute",
    toolName: name,
    description: `OVERDARE RAG search [${args.source}]: ${args.query}`,
    details: { query: args.query, source: args.source, topK: args.topK },
  });
  if (approval === "reject") {
    return { output: "[Rejected by user]", metadata: { error: true } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/api/chat/rag`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: args.query,
        version: "3",
        source: args.source,
        topK: args.topK ?? 4,
        threshold: 0.5,
        ...(args.source === "debug" && args.debugCaseFilter ? { debugCaseFilter: args.debugCaseFilter } : {}),
        ...(args.source === "vfx" && args.vfxDocTypes?.length ? { vfxDocTypes: args.vfxDocTypes } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = errText.substring(0, 200);
      try {
        const errJson = JSON.parse(errText) as { error?: string };
        if (errJson?.error) errMsg = errJson.error.substring(0, 200);
      } catch {
        // ignore parse error, use raw text
      }
      throw new Error(`OVERDARE RAG search failed (HTTP ${response.status}): ${errMsg}`);
    }

    const data = (await response.json()) as RagResponse;
    const results = (data?.results ?? []).filter((result) => {
      if ((result.text ?? "").length > 0) return true;
      if ("script" in result && ((result as RagResult).script ?? "").length > 0) return true;
      // Debug cases are identified by caseId, not by having a solution (text=solution may be omitted).
      if (args.source === "debug" && isDebugResult(result)) return true;
      return false;
    });

    if (args.source === "assets") {
      const rawAssets = results.filter(isAssetResult);
      const assetResults = rawAssets.map(normalizeAssetResult);

      if (args.selectable) {
        if (rawAssets.length === 0) {
          return { output: "No results found.", metadata: { resultCount: 0 } };
        }
        if (rawAssets.length === 1) {
          return autoSelectResult(rawAssets[0], 1);
        }
        // Audio/Animation/Effects/UI and Action-Sequence assets skip the picker
        // and auto-select the top-scored match.
        if (shouldAutoSelect(rawAssets[0])) {
          return autoSelectResult(rawAssets[0], rawAssets.length);
        }
        const output = await selectAsset(host, args.query, rawAssets);
        return { output, metadata: { resultCount: rawAssets.length } };
      }

      return {
        output: assetResults.length
          ? JSON.stringify({ results: assetResults, totalCount: data?.totalCount ?? assetResults.length }, null, 2)
          : "No results found.",
        render: buildSearchRender({ source: args.source, query: args.query }, rawAssets),
        metadata: { resultCount: assetResults.length, results: assetResults },
      };
    }

    if (args.source === "debug") {
      const rawDebug = results.filter(isDebugResult);
      const debugResults = rawDebug.map(normalizeDebugResult);
      return {
        output: debugResults.length
          ? JSON.stringify({ results: debugResults, totalCount: data?.totalCount ?? debugResults.length }, null, 2)
          : "No results found.",
        render: buildSearchRender({ source: args.source, query: args.query }, rawDebug),
        metadata: { resultCount: debugResults.length, results: debugResults },
      };
    }

    if (args.source === "vfx") {
      const rawVfx = results.filter(isVfxResult);
      const vfxResults = rawVfx.map(normalizeVfxResult);
      return {
        output: vfxResults.length
          ? JSON.stringify({ results: vfxResults, totalCount: data?.totalCount ?? vfxResults.length }, null, 2)
          : "No results found.",
        render: buildSearchRender({ source: args.source, query: args.query }, rawVfx),
        metadata: { resultCount: vfxResults.length, results: vfxResults },
      };
    }

    const ragResults = results.filter(
      (result): result is RagResult => !isAssetResult(result) && !isDebugResult(result) && !isVfxResult(result),
    );

    return {
      output: ragResults.length ? JSON.stringify(ragResults, null, 2) : "No results found.",
      render: buildSearchRender({ source: args.source, query: args.query }, ragResults),
      metadata: { resultCount: ragResults.length, results: ragResults },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("OVERDARE RAG search timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
