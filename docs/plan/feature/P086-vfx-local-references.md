# P086 — Bundle VFX reference data locally (drop overdaresearch vfx source)

- Status: approved design, pending implementation
- Branch: `feat/vfx-recipe-support` (PR #375)
- Date: 2026-08-26
- Owner: marklee

## Motivation

PR #375 added VFX support routed through `overdaresearch source=vfx`, which depends on a
Weaviate `vfx` collection and aiguide API routing that never shipped — the PR has been on
merge hold since 2026-08-11. The VFX corpus is small (146 presets, ~15 sources, 7 recipe
templates) and changes slowly, so RAG infrastructure is overkill. Instead, diligent bundles
the data as markdown files inside the `vfx-recipe` skill and the agent searches them with
its built-in `read`/`grep`/`glob` tools. No network, no backend dependency, merge hold lifted.

This is the first time diligent carries reference data itself, but the pattern already
exists: `actionsequence/references/` (catalog + INDEX + JSON payloads) and
`tpa/references/` bundle files inside skill folders, and the bootstrap deploy copies skill
folders wholesale.

## Source data

All from `github.com/overdare/creator-guide-eng`, path `official-asset-info/`:

| Upstream file | Size | Shape |
|---|---|---|
| `vfxpreset-asset-list.md` | 136 KB | Serialized HTML table, 146 rows, heavy noise (GIF `<img>` tags, thumbnails, publish metadata, Korean prose) |
| `vfxsource-asset-list.md` | 38 KB | Header-based sections (h2 per source, metadata list + user parameters), English, well-structured |
| `vfx-recipe-template/combo_01…07_en.md` | 66 KB total | 7 files, rich YAML frontmatter + search summary + composition tables + Original Payload JSON. Designed for retrieval; usable near-verbatim |

## Decisions

1. **Full replacement** — remove `overdaresearch source=vfx`, `vfxDocTypes`, `VfxResult`
   and related tests from the branch. Local markdown is the only VFX data source.
2. **Distill, don't copy verbatim** — transform upstream data into agent-optimized files.
3. **Include a sync script** — the transform is mechanical; re-sync is one command.
4. **Store under `bootstrap/skills/vfx-recipe/references/`** — follows the established
   skill-references precedent; the data has exactly one consumer.
5. **Always ask the user upfront** how to build a new effect (preset / template-based /
   full custom), with a one-tier-down escape option at each subsequent selection step.

## File layout

```
apps/overdare-ai-agent/bootstrap/skills/vfx-recipe/
  SKILL.md                 # revised: local-file search + ask-first routing
  references/
    presets.md             # 146 presets, one line each (grep target)
    sources.md             # ~15 sources, near-verbatim minus noise
    templates/
      00_INDEX.md          # one-line summary per template (selection aid)
      combo_01_*.md … combo_07_*.md   # upstream files verbatim
```

### Distillation rules

- **`presets.md`** — parse the HTML table; keep per row: resource name, Studio display
  name, category (primary/secondary), genre, and the English keyword list extracted from
  the `Description` column's trailing `키워드:` line. Emit one markdown table row per
  preset so a single `grep -i` hit shows everything about a candidate. Drop images,
  thumbnails, publish status/build dates, and Korean prose (keeps the repo English-only
  and shrinks 136 KB → ~15 KB). If keyword-only matching proves too coarse, a one-line
  English description can be added later.
- **`sources.md`** — strip `<img>` lines and HTML comment blocks; keep everything else
  (already English: layer/spawnType/element metadata + user parameter sections).
- **`templates/`** — copy the 7 upstream files verbatim (embedded Korean
  `keywords_ko`/origin prompts are quoted upstream data, acceptable). Generate
  `00_INDEX.md` from each file's frontmatter: title, category, elements, sources,
  patterns, English keywords — one line per template.
- Every generated file starts with a comment stamping the upstream commit SHA and the
  sync script name.

## Sync script

`apps/overdare-ai-agent/scripts/sync-vfx-references.ts` (bun):

1. Fetch the three upstream paths via `gh api` (falls back to `GITHUB_TOKEN` + raw fetch).
2. Apply the distillation rules above (HTML table parsing, tag/comment stripping,
   frontmatter → INDEX).
3. Overwrite `references/` and print a row-count summary.

Re-sync = run the script, review the diff, commit.

## SKILL.md routing (v2 — ask first)

For a **new effect request**, first ask via `request_user_input`:

> **이 이펙트를 어떻게 만들까요?**
> 1. **기성 이펙트 사용** — 공식 이펙트 중 가장 잘 맞는 걸 바로 적용 (빠름·안정적)
> 2. **레시피 기반 커스텀** — 비슷한 공식 레시피를 복사해 요청에 맞게 수정 (권장)
> 3. **완전 커스텀** — 재료부터 직접 조합해 새로 제작 (자유도 최대)

Then search only the chosen unit:

- **Preset** → `grep` `references/presets.md` by English keywords; present matching
  presets as a second `request_user_input` choice **plus an escape option
  "레시피 기반 커스텀으로 만들기"**. On selection, create `class: "VFXPreset"` with the
  resource name as `PresetName`.
- **Template** → read `references/templates/00_INDEX.md`; present candidate templates
  **plus an escape option "완전 커스텀으로 만들기"**. On selection, read the chosen
  combo file, copy its Original Payload JSON into `class: "VFXRecipe"`, adapt as
  requested (color/alpha swaps, same-layer source swaps, intensity scaling — rules
  unchanged from the current skill).
- **Full custom** → read `references/sources.md`, compose layers directly
  (Base ≥ 1; `resourceName` feeds `NiagaraSystem`; rules unchanged).

If the chosen path yields no good match, say so and offer the next tier down.

**Skip the question when:**
- the request already names the method ("프리셋으로", "직접 조합해서"), or
- the request is an **edit of an existing VFXRecipe** — go straight to the edit flow
  (read → modify whole layer arrays → upsert by guid; unchanged).

Rate-vs-Burst parameter rules and the gotchas section carry over unchanged.

## Removals

- `overdaresearch.ts`: `vfx` enum value, `vfxDocTypes` param, `VfxResult`,
  `isVfxResult`, `normalizeVfxResult`, the vfx result branch, and vfx text in the tool
  description.
- `test/tools/overdaresearch-vfx.test.ts`.
- Update `instance.params.ts` `PresetName` description ("discover via overdaresearch
  source=vfx" → point at the skill's `references/presets.md`).
- Update the `system-prompt.txt` VFXRecipe line (drop the `overdaresearch source=vfx`
  mention).
- The `instance.upsert` VFXRecipe/VFXPreset schemas are **unchanged**.

## Testing

- **New: reference-consistency test** — parses the committed `references/` files and
  asserts: every template's `sources` / `NiagaraSystem` value exists in the upsert
  schema's per-layer source enums; `presets.md` has > 100 rows and every row's resource
  name matches `/^VFX_/`; `00_INDEX.md` lists exactly the template files present.
  Purpose: catch drift after a re-sync (e.g. upstream adds a source the schema doesn't
  know).
- Existing upsert schema tests stay as-is.
- `bun test`, `bun run typecheck`, `bun run lint`.
- The sync script itself is exercised manually (its output is the committed data the
  consistency test validates).

## PR impact

PR #375 loses its merge-hold reason: no Weaviate collection, no aiguide routing needed.
Update the PR body (remove the "Merge hold" section, rewrite the search-side summary)
and move the PR out of draft once E2E passes in Studio.
