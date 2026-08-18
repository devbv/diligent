---
id: P085
status: draft
created: 2026-08-18
---

# P085: Asset Pack Detection & Bulk Import

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user asks for themed content ("add a subway"), detect that a matching
asset *pack* exists, let the user choose single-asset vs whole-pack import, enumerate all
pack members exactly, bulk-import them with one approval, and place them via
procedural-builder when the count is large.

**Architecture:** Pack *detection* stays in hybrid search (relaxed-threshold scan,
aggregated server-side); pack *enumeration* becomes an exact Weaviate filter query
(`assetFilter`); import stays a per-asset Studio RPC looped inside one sidecar tool with a
single approval; placement is delegated to the existing procedural-builder transform path
keyed by the GUIDs returned from import. No procedural runtime changes.

**Tech Stack:** chatbot-api (Next.js, weaviate-client), diligent sidecar (Bun, zod,
TCP JSON-RPC), procedural Luau shim.

**Spec:** The "Verified Findings" section below — this plan was derived from live probes
against `https://aiguide.overdare.com/api/chat/rag` and a live Studio RPC session on
2026-08-18; there is no separate spec doc.

## Global Constraints

- All repo content (docs, comments, code) in English.
- The model-facing `overdaresearch.topK` zod cap stays at `max(10)`; all large fetches are
  tool-internal.
- No changes to `sidecar/src/procedural/*` — the Luau shim already exposes `.Guid` on
  injected scene instances (`procedural/luau/ovdr-shim.lua:679`).
- Studio wire protocol (current build): method `asset_drawer.import`, params
  `{assetid, assetName, assetType}` (lowercase), response `{success, guids: string[]}`.
  `asset_store.import` (capitalized spec doc) does NOT exist on this build.
- chatbot-api has no unit-test infra; its tasks verify via `curl` against a local dev
  server. Sidecar tasks use `bun test` under `apps/overdare-ai-agent/sidecar/test/`.

## Verified Findings (2026-08-18 live probes)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | Pack keyword convention is real: every member of a pack carries a shared `pack_<name>` entry in `keywords` | `pack_metro` found on 145 assets (query `pack_metro`, topK=200, threshold=0.05 → 192 results, 145 with the keyword) |
| 2 | Detection fails at the tool's default threshold | query `subway`: threshold 0.5 → 0 pack members surface; 0.4 → 1; 0.3 → 4 |
| 3 | The RAG API has no server-side topK cap | topK=200 accepted and honored by `v3.ts` (passes `topK` straight to Weaviate `limit`) |
| 4 | `asset_drawer.import` returns real scene ActorGuids | imported `ovdrassetid://41534300` → `guids: ["653B201E..."]`; `level.browse` shows that GUID as Workspace child `Metro_Can01` (class Model) |
| 5 | Scene name ≠ store title | store title "Can 01" spawned as `Metro_Can01` → name-matching is unreliable; GUID capture at import time is mandatory |
| 6 | A pack is a themed collection, not an exploded original scene | per product owner — no original-transform restoration; placement is creative composition |
| 7 | `WorldAssetRAG.keywords` is `text[]`, filterable | `studio-rag-data/batch/src/schemas/worldAssetSchema.json`; the `buildDebugFilters` pattern in `chatbot-api/app/api/chat/rag/weaviate.ts:133-151` is directly reusable |
| 8 | Enumeration via keyword *query* is inexact | topK=200 probe returned 47 non-pack junk rows alongside the 145 members — only a filter query guarantees exact membership |

## Pipeline Overview

```
user: "add a subway"
  │
  ▼
overdaresearch(assets, "subway")            ← model calls, unchanged UX
  │  server: hybrid search + internal relaxed pack scan (threshold 0.3, limit 20)
  │  server: response gains packs: [{keyword: "pack_metro", memberCount: 145}]
  ▼
picker: [Prop_Subway_001] [...] [📦 Metro pack (145 assets)]   ← synthetic option
  │  user picks the pack
  ▼
tool-internal enumeration: POST rag {assetFilter: {keywords: ["pack_metro"]}}
  │  exact member list (fetchObjects, no scores)
  ▼
model selects the subset the request actually needs (e.g. 20 of 145)
  │
  ├─ subset < 5  → studiorpc_asset_drawer_import × N + studiorpc_instance_move
  └─ subset ≥ 5  → studiorpc_asset_drawer_import_bulk (1 approval, N sequential RPCs,
                    collects {assetid → guids}) → procedural recipe places by .Guid
```

---

## Part A — chatbot-api (`~/Desktop/workhard/chatbot-api`)

### Task A1: `assetFilter` + enumeration mode

**Files:**
- Modify: `app/api/chat/rag/types.ts` (add `AssetFilter`, extend `RagRequestBody`)
- Modify: `app/api/chat/rag/weaviate.ts` (filter builder + enumeration branch in `searchWeaviateAssets`)
- Modify: `app/api/chat/rag/v3.ts` (allow empty query when `assetFilter` present; pass through)
- Modify: `app/api/chat/rag/constants.ts` (add `ASSET_ENUM_LIMIT`)

**Interfaces:**
- Consumes: existing `searchWeaviateAssets(accessToken, query, options)`,
  `buildDebugFilters` pattern, `WeaviateSearchOptions`.
- Produces: `AssetFilter = { keywords?: string[]; assetType?: string; categoryId?: string }`;
  `WeaviateSearchOptions.assetFilter?: AssetFilter`; request contract
  `POST /api/chat/rag {version:"3", source:"assets", assetFilter, query?}`.
  **Mode rule:** `assetFilter` present + `query` absent/empty → enumeration
  (`fetchObjects`, `limit = ASSET_ENUM_LIMIT = 500`, `topK`/`threshold` ignored, no
  scores); `query` + `assetFilter` → hybrid search with `filters` applied, `topK`/
  `threshold` keep their current meaning.

- [ ] **Step 1: Add types**

```ts
// types.ts
export interface AssetFilter {
  keywords?: string[]   // containsAny on WorldAssetRAG.keywords
  assetType?: string    // equal
  categoryId?: string   // equal
}
// RagRequestBody: add
//   assetFilter?: AssetFilter
//   includePacks?: boolean   // consumed in Task A2
```

- [ ] **Step 2: Filter builder + enumeration branch in `weaviate.ts`**

```ts
function buildAssetFilters(
  collection: Collection,
  filter?: AssetFilter,
): FilterValue | undefined {
  if (!filter) return undefined
  const conditions: FilterValue[] = []
  if (filter.keywords?.length)
    conditions.push(collection.filter.byProperty('keywords').containsAny(filter.keywords))
  if (filter.assetType)
    conditions.push(collection.filter.byProperty('assetType').equal(filter.assetType))
  if (filter.categoryId)
    conditions.push(collection.filter.byProperty('categoryId').equal(filter.categoryId))
  if (conditions.length === 0) return undefined
  if (conditions.length === 1) return conditions[0]
  return Filters.and(...conditions)
}
```

In `searchWeaviateAssets`, before the hybrid call:

```ts
const filters = buildAssetFilters(collection, options.assetFilter)

// Enumeration mode: filter-only fetch, unranked, exact membership.
if (filters && !query.trim()) {
  const result = await collection.query.fetchObjects({ filters, limit: ASSET_ENUM_LIMIT })
  return result.objects.map((obj) => mapAssetProperties(obj)) // score omitted — no ranking exists
}

const result = await collection.query.hybrid(query, {
  alpha, limit, returnMetadata: ['score'],
  ...(filters && { filters }),
})
```

Extract the existing `.map((obj) => {...})` body into `mapAssetProperties(obj)` so both
branches share it (threshold filter stays on the hybrid branch only).

- [ ] **Step 3: Relax the query guard in `v3.ts`**

The current handler 400s on a missing query. Change to: reject only when *both* `query`
and `assetFilter` are empty, and thread `assetFilter` through `searchBySource` into the
`RAG_SOURCE.ASSETS` branch (`assetFilter` is assets-only; other sources ignore it).

- [ ] **Step 4: Verify with curl against local dev**

```bash
# enumeration: exact members, no junk tail
curl -s -X POST localhost:3000/api/chat/rag -H "Content-Type: application/json" \
  -d '{"version":"3","source":"assets","assetFilter":{"keywords":["pack_metro"]}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); rs=d['results']; \
print(len(rs), all('pack_metro' in (r.get('keywords') or []) for r in rs))"
# Expected: 145 True
# hybrid + filter: ranked subset within the pack
curl -s -X POST localhost:3000/api/chat/rag -H "Content-Type: application/json" \
  -d '{"version":"3","source":"assets","query":"bench","topK":5,"threshold":0.2,"assetFilter":{"keywords":["pack_metro"]}}'
# Expected: ≤5 results, all with pack_metro keyword
# guard: both empty → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/chat/rag \
  -H "Content-Type: application/json" -d '{"version":"3","source":"assets"}'
# Expected: 400
```

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/rag/types.ts app/api/chat/rag/weaviate.ts app/api/chat/rag/v3.ts app/api/chat/rag/constants.ts
git commit -m "feat(rag): add assetFilter with filter-only enumeration mode for assets"
```

### Task A2: `includePacks` server-side pack aggregation

**Files:**
- Modify: `app/api/chat/rag/weaviate.ts` (pack scan inside `searchWeaviateAssets`)
- Modify: `app/api/chat/rag/v3.ts` (thread `includePacks`, add `packs` to response)
- Modify: `app/api/chat/rag/types.ts` (`RagResponse.packs?: PackInfo[]`)
- Modify: `app/api/chat/rag/constants.ts` (`PACK_SCAN_THRESHOLD = 0.3`, `PACK_SCAN_LIMIT = 20`, `PACK_KEYWORD_PREFIX = 'pack_'`)

**Interfaces:**
- Consumes: Task A1's `buildAssetFilters`, `mapAssetProperties`.
- Produces: `PackInfo = { keyword: string; memberCount: number }`; response contract:
  when `includePacks: true` and `source === 'assets'`, `RagResponse` gains
  `packs: PackInfo[]` (empty array when none detected). Client threshold/topK semantics
  for `results` are unchanged.

**Why server-side:** finding #2 — at the client's default threshold 0.5, pack members
never surface, so the client cannot detect packs without a second relaxed request. Doing
the relaxed scan server-side costs one Weaviate query re-use (single hybrid fetch with
`limit = max(topK, PACK_SCAN_LIMIT)`, then slice) plus one cheap `aggregate` per detected
pack for the exact member count.

- [ ] **Step 1: Implement scan in `searchWeaviateAssets` (hybrid branch only)**

```ts
// Fetch once with the relaxed floor and the larger limit; derive both outputs.
const scanLimit = Math.max(limit, PACK_SCAN_LIMIT)
const result = await collection.query.hybrid(query, {
  alpha, limit: scanLimit, returnMetadata: ['score'], ...(filters && { filters }),
})
const all = result.objects.map(mapAssetProperties)

// Client-facing results keep the caller's threshold/topK.
const results = all.filter((r) => (r.score ?? 0) >= threshold).slice(0, limit)

// Pack detection uses the relaxed superset.
let packs: PackInfo[] = []
if (options.includePacks) {
  const detected = new Set<string>()
  for (const r of all.filter((r) => (r.score ?? 0) >= PACK_SCAN_THRESHOLD))
    for (const k of r.keywords ?? [])
      if (k.startsWith(PACK_KEYWORD_PREFIX)) detected.add(k)
  packs = await Promise.all([...detected].map(async (keyword) => {
    const agg = await collection.aggregate.overAll({
      filters: collection.filter.byProperty('keywords').containsAny([keyword]),
    })
    return { keyword, memberCount: agg.totalCount ?? 0 }
  }))
}
return { results, packs }
```

Adjust the function's return type to `{ results: RagContextWithOrigin[]; packs: PackInfo[] }`
for the assets path (or add an out-param — follow whichever shape touches fewer call
sites; `searchBySource` in `v3.ts` is the only caller).

- [ ] **Step 2: Verify with curl**

```bash
curl -s -X POST localhost:3000/api/chat/rag -H "Content-Type: application/json" \
  -d '{"version":"3","source":"assets","query":"subway","topK":8,"threshold":0.5,"includePacks":true}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']), d.get('packs'))"
# Expected: results unchanged vs today (1 item, Prop_Subway_001),
#           packs: [{"keyword":"pack_metro","memberCount":145}]
```

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/rag/
git commit -m "feat(rag): aggregate pack_* keywords server-side via includePacks"
```

---

## Part B — diligent sidecar (`apps/overdare-ai-agent/sidecar`)

### Task B1: Pack detection in `overdaresearch` picker

**Files:**
- Modify: `src/tools/rag/overdaresearch.ts`
- Test: `test/tools/overdaresearch-pack.test.ts` (new)

**Interfaces:**
- Consumes: Part A response contract (`packs: PackInfo[]`, enumeration mode).
- Produces: picker options may include synthetic value `pack:<keyword>`; on pack
  selection the tool returns to the model a JSON member list:
  `{ pack: "pack_metro", memberCount: 145, members: [{ assetId, title, assetType, keywords }] }`.
  `metadata.packKeyword` is set for downstream rendering.

- [ ] **Step 1: Write the failing test**

Follow the existing tool-test setup in `test/tools/` (mock `fetch`; the tool host's
`requestToolUserInput` is injectable via the `host` argument). Cover three behaviors:

```ts
import { describe, expect, test } from "bun:test";
// 1. assets+selectable request body includes includePacks: true
// 2. when the response carries packs, picker options gain
//    { label: "Import full pack: pack_metro (145 assets)", value: "pack:pack_metro" }
// 3. when the user answers "pack:pack_metro", the tool issues a second fetch with
//    body {version:"3", source:"assets", assetFilter:{keywords:["pack_metro"]}} (no query)
//    and returns output containing all member assetIds
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/tools/overdaresearch-pack.test.ts` → FAIL

- [ ] **Step 3: Implement**

In `execute` (assets + selectable path):
- add `includePacks: true` to the request body when `args.source === "assets" && args.selectable`;
- after `selectAsset` options are built, append one option per `data.packs` entry
  (skip when `rawAssets.length === 1` auto-select or `shouldAutoSelect` short-circuits —
  packs only make sense when a picker is actually shown);
- when the chosen value starts with `pack:`, run the enumeration fetch
  (`assetFilter: { keywords: [keyword] }`, no `query`, no `topK`) and return the member
  list JSON as `output` — the member list goes to the model, not into another picker.

- [ ] **Step 4: Run tests** — `bun test test/tools/` → PASS (including existing overdaresearch tests)

- [ ] **Step 5: Commit**

```bash
git add apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts apps/overdare-ai-agent/sidecar/test/tools/overdaresearch-pack.test.ts
git commit -m "feat(overdare): surface asset packs in search picker and enumerate members"
```

### Task B2: `studiorpc_asset_drawer_import_bulk`

**Files:**
- Create: `src/tools/studiorpc/tools/asset-drawer-import-bulk-tool.ts`
- Modify: `src/tools/studiorpc/index.ts` (wire into the explicit `tools` list with `withSnapshot`)
- Modify: `src/tools/studiorpc/tool-registry.ts` (render entry)
- Test: `test/tools/asset-drawer-import-bulk.test.ts` (new)

**Interfaces:**
- Consumes: `call(method, params)` from `src/tools/studiorpc/rpc.ts` (injectable as
  `ctx.callRpc`, same seam the generic method tools use); `requestToolApproval` via the
  wrapped host; `withSnapshot` from `index.ts`.
- Produces: tool `studiorpc_asset_drawer_import_bulk` with params

```ts
export const params = z.object({
  assets: z
    .array(z.object({
      assetid: z.string().describe('Asset Drawer asset id, e.g. "ovdrassetid://12345"'),
      assetName: z.string().describe("Asset name shown in Asset Drawer"),
    }))
    .min(2)
    .max(200)
    .describe("Assets to import in one approved batch. MODEL type only."),
});
```

  Output (JSON string): `{ imported: [{ assetid, assetName, guids: string[] }], failed: [{ assetid, error }] }`.
  **The `guids` mapping is the contract Task B3's recipes depend on** (finding #5:
  scene names are unreliable).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
// Use a stub callRpc that records calls and returns {success: true, guids: ["G1"]},
// failing for one designated assetid.
// 1. one approval request total (not per asset), description mentions the count
// 2. calls asset_drawer.import sequentially, once per entry, assetType "MODEL"
// 3. a mid-batch RPC failure lands in `failed` and does NOT abort later imports
// 4. output JSON maps every assetid to its returned guids
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/tools/asset-drawer-import-bulk.test.ts` → FAIL

- [ ] **Step 3: Implement**

Sequential loop (Studio is a single-document editor — no concurrent imports), per-call
`try/catch` into `failed`, single upfront approval
(`description: \`Import ${assets.length} assets from Asset Drawer\``). Reuse the
`asset_drawer.import` wire params verbatim: `{assetid, assetName, assetType: "MODEL"}`.
Wire into `index.ts` next to the other mutating tools:

```ts
wrapTool(withSnapshot(createAssetDrawerImportBulkTool(callRpc)), ctx.host),
```

- [ ] **Step 4: Run tests** — `bun test test/tools/` → PASS

- [ ] **Step 5: Commit**

```bash
git add apps/overdare-ai-agent/sidecar/src/tools/studiorpc/ apps/overdare-ai-agent/sidecar/test/tools/asset-drawer-import-bulk.test.ts
git commit -m "feat(overdare): add bulk Asset Drawer import with single approval and guid map"
```

### Task B3: `asset-pack-import` skill

**Files:**
- Create: `bootstrap/skills/asset-pack-import/SKILL.md`

**Interfaces:**
- Consumes: Task B1's pack picker + member-list output, Task B2's guid map, the existing
  procedural-builder skill's transform mode.
- Produces: the workflow contract the model follows for themed/bulk requests.

- [ ] **Step 1: Write SKILL.md**

Frontmatter description must trigger on themed-scene / bulk-asset requests ("build a
subway station", "add a forest", "fill this area with props"). Body contract:

1. Search with `overdaresearch(source=assets)` as usual; if the picker returns a pack
   member list, that list is the palette — do not re-search per item.
2. Select the subset the request actually needs; a pack is a themed collection, not a
   prefab scene — composition is the agent's job (never blind-import all members).
3. Branch on subset size:
   - **< 5** → `studiorpc_asset_drawer_import` per asset, then `studiorpc_instance_move`
     for placement.
   - **≥ 5** → `studiorpc_asset_drawer_import_bulk`, then place with a procedural recipe.
4. GUID discipline: pass the bulk-import guid map into the recipe via
   `parameters.Attributes` (e.g. `Attributes = { PlacementGuids = { "653B..", ... } }`).
   Never locate imported models by name — imported scene names differ from store titles
   (e.g. store "Can 01" spawns as `Metro_Can01`).
5. Include one placement-recipe example: iterate `workspace:GetDescendants()`, match
   `inst.Guid` against `parameters.Attributes.PlacementGuids`, assign `CFrame`s from
   `MathUtils.pointsOnGrid` (see the procedural-builder skill's convergence rules for
   reruns).

- [ ] **Step 2: Verify skill loads**

Run the existing bootstrap-config test suite (`bun test test/bootstrap-config.test.ts`)
— it validates bundled skill frontmatter; fix any schema complaints.

- [ ] **Step 3: Commit**

```bash
git add apps/overdare-ai-agent/bootstrap/skills/asset-pack-import/
git commit -m "feat(overdare): add asset-pack-import skill for pack workflows"
```

### Task B4: Live E2E against dev-cross Studio

**Files:** none (manual verification; record results in the PR description)

- [ ] **Step 1:** `make dev-cross STUDIO_HOST=<windows-ip>`, prompt: *"add a subway
  station to the level"*.
- [ ] **Step 2:** Verify the picker shows the Metro pack synthetic option with a member
  count; pick it.
- [ ] **Step 3:** Verify one approval for the bulk import; after the turn, `level.browse`
  (or the Studio outliner) shows the imported models and the recipe placed them by GUID
  (no stacking at a single default spawn point).
- [ ] **Step 4:** Rerun the same prompt; verify the recipe converges (no duplicate
  placement) per the procedural-builder convergence rules.

---

## Deferred / Out of Scope

- **Studio-side batch import RPC** — the sidecar loop is O(N) round trips; if packs grow
  past a few hundred items or per-call latency hurts, ask the Studio team for a native
  batch method. Not needed for v1.
- **Import spawn position** — unknown (couldn't read transforms pre-save); irrelevant
  while the recipe re-places everything it imports. Revisit only if the <5 direct path
  looks bad in practice.
- **`packId` schema promotion** — `pack_` keywords work today; a dedicated filterable
  `packId` property in `WorldAssetRAG` would be cleaner but requires a reindex in
  studio-rag-data. Revisit when the pack catalog grows.
- **Enumeration paging** — `ASSET_ENUM_LIMIT = 500` is a safety cap; response
  `totalCount` tells the client when a pack was truncated.
