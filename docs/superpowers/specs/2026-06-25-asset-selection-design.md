# Interactive World-Asset Selection — Design

**Date:** 2026-06-25
**Branch:** `feat/web-asset-preview`
**Status:** Approved (design phase)

## Problem

The branch already turns `worldAsset` (RAG) search results into a read-only
thumbnail gallery (`asset_gallery` render block). But when a search returns
multiple candidates, the **agent** silently picks one `assetId` and imports it
via `asset_drawer.import`. The user has no say in which asset is chosen.

We want the **user** to pick. Two requirements:

1. When an asset search returns a list, present the images **as a selectable
   list** so the user chooses a specific asset.
2. Support flows that need several assets across several searches (e.g. "make a
   soccer player" → top, bottom, ball, shoes). Handled **sequentially**: one
   search + pick per asset kind.

## Decisions (locked)

- **Selection is an answer, not an action.** The user's pick returns the chosen
  `assetId` to the agent; the agent then decides/confirms and performs the
  `asset_drawer.import` placement. No auto-placement from the UI.
- **Sequential multi-asset.** The agent calls the selectable search once per
  asset kind. One picker card = one asset kind. No batch/multi-question card in
  v1 (YAGNI).
- **Search _is_ the picker.** When a selection is intended, the search result
  surfaces as a single selectable picker card — no separate read-only gallery
  shown alongside it (no duplication).
- **Server-side picker build (Approach C).** The picker request is built inside
  `overdaresearch.execute()` (plain server-side TypeScript running in the Bun
  sidecar), **not** by the LLM. Asset visuals (thumbnail/price/...) never enter
  the LLM context, so they cost zero tokens and never persist in conversation
  history.

### Why Approach C over A

Approach A would have the LLM call a generic `request_user_input` with the asset
visuals filled into its arguments. That fails on two counts:

- The agent-facing search output (`normalizeAssetResult`) **strips**
  `thumbnailUrl/previewUrl/price`; the LLM never receives them, so it cannot
  populate a picker.
- Shuttling image URLs through the LLM context wastes tokens on every turn
  (tool args + results persist in history).

Approach C keeps the rich `rawAssets` (already in hand inside `execute()`)
server-side and routes only the chosen `assetId` back to the agent.

## Architecture

Four runtime layers (for grounding the data flow):

```
① Rust launcher (.exe)         spawns ②
② Bun sidecar (one process)    web server; hosts ③ + serves ④
   ③ agent runtime (server)    LLM loop + tool execute()  ← picker built here
   ④ frontend (browser)        React UI (QuestionCard)    ← picker rendered here
```

Data flow for a selectable search:

```
agent (LLM) → overdaresearch({source:"assets", query, topK, selectable:true})
  └─ execute() [server, no LLM]:
       fetch RAG → rawAssets (thumbnail/price/id in hand)
       count == 0 → return "No results found." (no picker)
       count == 1 → return that assetId immediately (auto-pass, no picker)
       count >= 2 → requestToolUserInput(host, assetPickerRequest)  ──▶ ④ frontend
                      user clicks a thumbnail
                    ◀── answer = chosen assetId (option.value)
       return { output: chosen assetId + title }
agent (LLM) → confirms, then asset_drawer.import(assetId) → next asset kind
```

Asset visuals flow only ②③ → ④. The LLM sees only `query` in and `assetId`
out.

## Components & Changes

### 1. Protocol — `packages/protocol/src/data-model.ts`

Extend the user-input contract so an option can carry an asset visual and return
a value distinct from its label.

- `UserInputOptionSchema`: add
  - `value?: string` — value returned as the answer when this option is chosen
    (falls back to `label` when absent). For assets, `value = assetId`.
  - `asset?: { thumbnailUrl?, previewUrl?, price?, subtitle?, metadata? }` —
    visual fields (reuse the shape already defined for `AssetGalleryItem` in
    `tool-render.ts`; share a single schema rather than duplicating).
- `UserInputQuestionSchema`: add `display?: "asset"` — explicit hint that the
  client should render the asset-grid variant. (Explicit beats inferring from
  option shape.)

These are additive and optional, so existing `request_user_input` payloads and
the CLI/text path are unaffected.

### 2. Answer → value mapping

Today `QuestionCard` returns `opt.label` as the answer. Asset titles can
collide, and the agent needs the `assetId`. Introduce `option.value`: when
present, the chosen answer is `value`; otherwise `label` (backward compatible).
All three return paths (web/cli/vscode) and the request_user_input answer
formatting must honor `value`.

### 3. Sidecar — `overdaresearch` selectable flag

`apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts`

- Add `selectable?: boolean` to `parameters` (meaningful only for
  `source:"assets"`; document that constraint in the description).
- In `execute()` for `source:"assets"` when `selectable` is true, branch on
  `rawAssets.length`:
  - `0` → existing "No results found." output, no picker.
  - `1` → return that asset's `assetId` (+ title) immediately. Auto-pass.
  - `>= 2` → build an asset picker `UserInputRequest` from `rawAssets` (title →
    `label`, `assetId` → `value`, thumbnail/price/etc. → `asset`,
    `display:"asset"`), call `requestToolUserInput(host, ...)`, map the answer
    back to the chosen `assetId`, and return it as `output`.
- Cancellation reuses the existing user-input cancel path (no answer →
  cancelled / abort), mirroring `request_user_input`.
- Build the picker options from the **raw** asset objects (which already hold
  the visual fields), reusing the existing `readStringField` normalization logic
  in `render.ts`. Factor that field-reading into a shared helper so the picker
  and the `asset_gallery` render stay consistent.
- Note on `supportParallel`: a selectable call pauses for input. This is the
  same pause `request_user_input` performs and is safe; the agent is instructed
  to use `selectable` only for a deliberate single selection, not in a parallel
  fan-out.

### 4. Frontend — `packages/web/src/client/components/QuestionCard.tsx`

- When `question.display === "asset"`, render a **selectable thumbnail grid**
  instead of text option rows: each tile shows the asset image (with the
  existing initial-letter fallback), title, and price/subtitle; clicking a tile
  selects it (single-select). The custom free-form input row stays.
- Reuse the asset tile/`AssetImage` visuals from `ToolRenderBlocks.tsx` by
  extracting a shared presentational component (e.g. `AssetTile` /
  `AssetThumbnail`) so the gallery block and the picker render identically.
- Selecting a tile sets the answer to the option's `value` (the `assetId`).

### 5. CLI / VS Code

- The CLI/TUI request_user_input renderer lists asset options as a numbered
  list (title + price + id), consistent with the existing text-option rendering.
  No thumbnails in the terminal. Honor `value` on selection.
- VS Code webview path mirrors the web behavior where feasible; minimum bar is
  honoring `value` and listing options.

### 6. Reuse — `asset_gallery` render block stays

The branch's `asset_gallery` block remains for **non-interactive** asset
searches (the agent searching to inform itself, `selectable` false/omitted). The
picker and the gallery share the extracted `AssetTile` visual, so the branch
work is not discarded.

## Error / Edge Handling

| Case | Behavior |
| --- | --- |
| 0 results | `"No results found."`, no picker; agent may refine the query. |
| 1 result | Auto-select that asset, return its `assetId`, no picker. |
| ≥2 results | Picker shown; user selects one. |
| User cancels | Reuse existing user-input cancel/abort path. |
| Image fails to load | Existing initial-letter fallback tile. |
| `selectable` with non-asset source | Flag ignored; behaves as a normal search (documented). |

## Testing

- **protocol**: schema round-trip for `value`, `asset`, and `display:"asset"`;
  backward compatibility (existing payloads still parse).
- **sidecar**: `overdaresearch` selectable path with mocked RAG fetch —
  0/1/≥2 result branches; picker request shape (label/value/asset/display);
  answer→assetId mapping; cancel path.
- **web**: `QuestionCard` asset-grid variant renders tiles, click selects the
  `value`, custom input still works; `AssetTile` shared component renders in
  both gallery and picker.
- **cli**: numbered asset-option list renders and returns `value`.

## Out of Scope (v1)

- Batch / multi-question selection in a single card.
- Multi-select of several assets at once.
- Making the standalone `asset_gallery` render block itself clickable (no
  feedback channel; superseded by the selectable search path).
