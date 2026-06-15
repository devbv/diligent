import type { ToolContext, ToolResult } from "@diligent/core/tool/types";
import { type RuntimeToolHost, requestToolApproval } from "@diligent/runtime";
import { z } from "zod";
import { buildSearchRender } from "./render";

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

type AnyResult = RagResult | AssetResult | DebugResult;

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
  - Default topK by source: docs=4, code=4, assets=8, debug=5; only increase if results are insufficient
  - "docs": API references, conceptual guides, configuration details, service descriptions
  - "code": Working Lua implementation examples, proven patterns, real script snippets
  - "assets": Asset catalog search returning asset metadata such as title, keywords, assetId, assetType, categoryId, and subCategoryId
  - "debug": Debugging-case knowledge base (symptom → cause → solution). Each result includes symptom, causeClassification, solution, and caseId. Use when diagnosing a bug or unexpected behavior — describe the symptom in natural language.
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
    .enum(["docs", "code", "assets", "debug"])
    .describe(
      "docs = API references and guides. code = working Lua implementation examples and patterns. assets = asset catalog search with asset metadata fields. debug = debugging cases (symptom → cause → solution).",
    ),
  topK: z.number().int().min(1).max(10).describe("Number of results to return"),
  debugCaseFilter: z
    .object({
      caseId: z.string().optional().describe("Exact match on case ID"),
      category: z.string().optional().describe("Exact match on category (ui, script, tooling, 3d, ...)"),
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

    const ragResults = results.filter(
      (result): result is RagResult => !isAssetResult(result) && !isDebugResult(result),
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
