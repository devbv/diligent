# Interactive World-Asset Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick a specific asset from `worldAsset` search results via a thumbnail picker, returning the chosen `assetId` to the agent.

**Architecture:** Add a `selectable` flag to the `overdaresearch` tool. When set (assets only), the tool's `execute()` — running server-side in the Bun sidecar — builds an asset picker request from the raw search results and routes it to the frontend through the existing `requestToolUserInput` pause/resume channel. The chosen `assetId` is returned to the agent; asset thumbnails never enter the LLM context. The user-input protocol gains optional `value`, `asset`, and `display` fields so an option can carry a thumbnail and return an id distinct from its label.

**Tech Stack:** TypeScript, Zod (protocol schemas), Bun (sidecar + test runner), React + Tailwind (web client), custom TUI components (CLI).

**Spec:** `docs/superpowers/specs/2026-06-25-asset-selection-design.md`

## Global Constraints

- All git-tracked content (code, comments, docs, commit messages) must be English.
- Commit titles must pass the conventional-commit validator: `type(scope): subject` (e.g. `feat(protocol): ...`). The pre-commit hook runs biome lint + `tsc` typecheck across packages and will block on lint/type errors.
- Protocol schema changes are additive and optional only — existing `request_user_input` payloads and the text-option path must keep parsing and behaving unchanged (backward compatible).
- Run the repo from its root: `/Users/marklee/Desktop/workhard/diligent`.
- Per-package tests run with Bun, e.g. `bun test <path>` from the relevant package, or via the repo's test scripts.

---

### Task 1: Protocol — `value`, `asset`, `display` on user-input schemas

**Files:**
- Modify: `packages/protocol/src/data-model.ts:367-381`
- Test: `packages/protocol/test/user-input.test.ts` (create)

**Interfaces:**
- Produces:
  - `UserInputOptionAssetSchema` / type `UserInputOptionAsset` — `{ thumbnailUrl?: string; previewUrl?: string; price?: string; subtitle?: string; metadata?: Array<{ key: string; value: string }> }`
  - `UserInputOptionSchema` gains `value?: string` and `asset?: UserInputOptionAsset`
  - `UserInputQuestionSchema` gains `display?: "asset"`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/user-input.test.ts`:

```ts
// @summary Tests user-input schema asset-picker extensions (value/asset/display) and backward compatibility.

import { describe, expect, test } from "bun:test";
import { UserInputRequestSchema } from "../src/data-model";

describe("UserInputRequestSchema asset picker fields", () => {
  test("parses asset options with value/asset and the display hint", () => {
    const parsed = UserInputRequestSchema.parse({
      questions: [
        {
          id: "asset",
          header: "Asset",
          question: 'Pick an asset for "katana"',
          display: "asset",
          options: [
            {
              label: "Katana, Rusty",
              description: "MODEL",
              value: "6584600",
              asset: { thumbnailUrl: "https://assets.example/k.png", price: "100" },
            },
          ],
        },
      ],
    });

    expect(parsed.questions[0].display).toBe("asset");
    expect(parsed.questions[0].options[0].value).toBe("6584600");
    expect(parsed.questions[0].options[0].asset?.thumbnailUrl).toBe("https://assets.example/k.png");
  });

  test("still parses legacy text options without the new fields", () => {
    const parsed = UserInputRequestSchema.parse({
      questions: [{ id: "q1", header: "Q", question: "Pick", options: [{ label: "A", description: "a" }] }],
    });

    expect(parsed.questions[0].options[0].value).toBeUndefined();
    expect(parsed.questions[0].display).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bun test test/user-input.test.ts`
Expected: FAIL — `display`/`value`/`asset` are stripped or the first test's assertions are `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/data-model.ts`, replace the `UserInputOptionSchema` block (lines 367-381) with:

```ts
export const UserInputOptionAssetSchema = z.object({
  thumbnailUrl: z.string().optional(),
  previewUrl: z.string().optional(),
  price: z.string().optional(),
  subtitle: z.string().optional(),
  metadata: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});
export type UserInputOptionAsset = z.infer<typeof UserInputOptionAssetSchema>;

export const UserInputOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  /** Value returned as the answer when chosen. Falls back to `label` when absent. */
  value: z.string().optional(),
  /** Visual fields for an asset-picker option (rendered as a thumbnail tile). */
  asset: UserInputOptionAssetSchema.optional(),
});
export type UserInputOption = z.infer<typeof UserInputOptionSchema>;

export const UserInputQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(UserInputOptionSchema).min(1),
  allow_multiple: z.boolean().optional(),
  is_secret: z.boolean().optional(),
  /** Client rendering hint. "asset" renders options as a selectable thumbnail grid. */
  display: z.enum(["asset"]).optional(),
});
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && bun test test/user-input.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the protocol package**

Run: `cd packages/protocol && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/data-model.ts packages/protocol/test/user-input.test.ts
git commit -m "feat(protocol): add value/asset/display to user-input options"
```

---

### Task 2: Web — extract shared `AssetThumbnail`

**Files:**
- Create: `packages/web/src/client/components/AssetThumbnail.tsx`
- Modify: `packages/web/src/client/components/ToolRenderBlocks.tsx:163-275` (replace local `AssetImage`/`assetInitial` usage)
- Test: `packages/web/test/client/components/components.test.tsx` (append)

**Interfaces:**
- Produces:
  - `AssetThumbnailData` — `{ title: string; subtitle?: string; thumbnailUrl?: string; previewUrl?: string }`
  - `AssetThumbnail({ asset, className }: { asset: AssetThumbnailData; className?: string })` — `<img>` with initial-letter fallback on missing/failed image.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/test/client/components/components.test.tsx`:

```tsx
test("AssetThumbnail renders the image when a url is present", () => {
  const html = renderToStaticMarkup(
    <AssetThumbnail asset={{ title: "Katana", thumbnailUrl: "https://assets.example/k.png" }} />,
  );
  expect(html).toContain("https://assets.example/k.png");
  expect(html).toContain('alt="Katana"');
});

test("AssetThumbnail falls back to the title initial when no url is present", () => {
  const html = renderToStaticMarkup(<AssetThumbnail asset={{ title: "katana" }} />);
  expect(html).not.toContain("<img");
  expect(html).toContain("K");
});
```

Add the import near the other component imports at the top of the file:

```tsx
import { AssetThumbnail } from "../../../src/client/components/AssetThumbnail";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun test test/client/components/components.test.tsx`
Expected: FAIL — module `AssetThumbnail` not found.

- [ ] **Step 3: Create the component**

Create `packages/web/src/client/components/AssetThumbnail.tsx`:

```tsx
// @summary Shared asset thumbnail with initial-letter fallback, used by the asset gallery block and the asset picker

import { useState } from "react";
import { cn } from "../lib/cn";

export interface AssetThumbnailData {
  title: string;
  subtitle?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
}

function assetInitial(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function AssetThumbnail({ asset, className }: { asset: AssetThumbnailData; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = asset.thumbnailUrl ?? asset.previewUrl;

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-1 bg-fill-secondary text-center",
          className,
        )}
      >
        <span className="text-2xl font-semibold leading-none text-text-soft">{assetInitial(asset.title)}</span>
        {asset.subtitle ? <span className="max-w-[9rem] truncate px-2 text-2xs text-muted">{asset.subtitle}</span> : null}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={asset.title}
      loading="eager"
      className={cn("h-full w-full object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}
```

- [ ] **Step 4: Use it in `ToolRenderBlocks.tsx`**

In `packages/web/src/client/components/ToolRenderBlocks.tsx`:

1. Add the import after the existing component imports (near line 22-24):

```tsx
import { AssetThumbnail } from "./AssetThumbnail";
```

2. Delete the local `assetInitial` function (lines 167-170) and the local `AssetImage` component (lines 185-212).

3. In `RenderAssetGallery`, replace the `<AssetImage item={item} />` usage (line 253) with:

```tsx
<AssetThumbnail asset={item} />
```

(`AssetGalleryItem` already has `title`, `subtitle`, `thumbnailUrl`, `previewUrl`, so it satisfies `AssetThumbnailData`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/web && bun test test/client/components/components.test.tsx`
Expected: PASS — new `AssetThumbnail` tests plus the existing asset-gallery tests still green.

- [ ] **Step 6: Typecheck the web package**

Run: `cd packages/web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors (no remaining references to the removed `AssetImage`/`assetInitial`).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/client/components/AssetThumbnail.tsx packages/web/src/client/components/ToolRenderBlocks.tsx packages/web/test/client/components/components.test.tsx
git commit -m "refactor(web): extract shared AssetThumbnail component"
```

---

### Task 3: Web — `QuestionCard` asset-grid variant + value-based answers

**Files:**
- Modify: `packages/web/src/client/components/QuestionCard.tsx:22-105`
- Test: `packages/web/test/client/components/components.test.tsx` (append)

**Interfaces:**
- Consumes: `AssetThumbnail` (Task 2), `UserInputOption.value`/`.asset`, `UserInputQuestion.display` (Task 1).
- Produces: `QuestionCard` renders a selectable thumbnail grid when `question.display === "asset"`, and returns `option.value ?? option.label` as the answer for every option type.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/test/client/components/components.test.tsx`:

```tsx
test("QuestionCard renders an asset thumbnail grid for display:asset questions", () => {
  const html = renderToStaticMarkup(
    <QuestionCard
      request={{
        questions: [
          {
            id: "asset",
            header: "Asset",
            question: 'Pick an asset for "katana"',
            display: "asset",
            options: [
              {
                label: "Katana, Rusty",
                description: "MODEL",
                value: "6584600",
                asset: { thumbnailUrl: "https://assets.example/k.png", price: "100" },
              },
            ],
          },
        ],
      }}
      answers={{}}
      onAnswerChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain("https://assets.example/k.png");
  expect(html).toContain("Katana, Rusty");
  expect(html).toContain("100");
});
```

Add the import at the top of the file if not already present:

```tsx
import { QuestionCard } from "../../../src/client/components/QuestionCard";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun test test/client/components/components.test.tsx`
Expected: FAIL — the asset grid is not rendered (no `<img>` / price), since `QuestionCard` currently renders text rows only.

- [ ] **Step 3: Implement the asset-grid variant and value mapping**

In `packages/web/src/client/components/QuestionCard.tsx`:

1. Add the import after the existing imports:

```tsx
import { AssetThumbnail } from "./AssetThumbnail";
```

2. Add a helper above the `QuestionCard` function:

```tsx
function optionValue(option: { label: string; value?: string }): string {
  return option.value ?? option.label;
}
```

3. Inside the `request.questions.map(...)` body, change the custom-value detection (line 33) to compare against `optionValue`:

```tsx
const customValue = selected.find((value) => !question.options.some((o) => optionValue(o) === value)) ?? "";
```

4. Add `const isAsset = question.display === "asset";` next to the other per-question locals (near line 31).

5. Replace the option-rendering block (the `{hasOptions ? question.options.map(...) : null}` block, lines 39-69) with:

```tsx
{isAsset ? (
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
    {question.options.map((opt) => {
      const val = optionValue(opt);
      const checked = selectedSet.has(val);
      const meta = opt.asset?.price ?? opt.description;
      return (
        <button
          key={val}
          type="button"
          data-asset-value={val}
          onClick={() => onAnswerChange(question.id, val)}
          className={`flex flex-col gap-1.5 rounded-md border p-1.5 text-left transition ${
            checked ? "border-accent bg-white/5" : "border-border/30 hover:bg-white/[.03]"
          }`}
        >
          <span className="block h-[7rem] w-full overflow-hidden rounded bg-fill-secondary">
            <AssetThumbnail
              asset={{
                title: opt.label,
                subtitle: opt.asset?.subtitle ?? opt.description,
                thumbnailUrl: opt.asset?.thumbnailUrl,
                previewUrl: opt.asset?.previewUrl,
              }}
            />
          </span>
          <span className="block truncate text-sm text-text-soft">{opt.label}</span>
          {meta ? <span className="block truncate text-xs text-muted">{meta}</span> : null}
        </button>
      );
    })}
  </div>
) : hasOptions ? (
  question.options.map((opt, i) => {
    const val = optionValue(opt);
    const checked = selectedSet.has(val);
    return (
      <button
        key={opt.label}
        type="button"
        onClick={() => {
          if (allowMultiple) {
            const next = checked ? selected.filter((v) => v !== val) : [...selected, val];
            onAnswerChange(question.id, next);
            return;
          }
          onAnswerChange(question.id, val);
        }}
        className={`flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
          checked ? "bg-white/5 text-text" : "text-muted hover:bg-white/[.03] hover:text-text"
        }`}
      >
        <span className="w-4 shrink-0 text-right font-mono text-xs opacity-40">{i + 1}</span>
        <span className="shrink-0 font-mono text-xs">
          {allowMultiple ? (checked ? "[x]" : "[ ]") : checked ? "(●)" : "( )"}
        </span>
        <span className="flex-1">{opt.label}</span>
        {opt.description ? <span className="shrink-0 text-xs opacity-40">{opt.description}</span> : null}
      </button>
    );
  })
) : null}
```

6. In the custom free-form input `onChange` handler, change the option filter (line 87) to use `optionValue`:

```tsx
const optionSelected = selected.filter((value) => question.options.some((o) => optionValue(o) === value));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && bun test test/client/components/components.test.tsx`
Expected: PASS — new asset-grid test plus all existing `QuestionCard` tests stay green (text-option path unchanged because `optionValue` returns `label` when `value` is absent).

- [ ] **Step 5: Typecheck the web package**

Run: `cd packages/web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/client/components/QuestionCard.tsx packages/web/test/client/components/components.test.tsx
git commit -m "feat(web): asset thumbnail picker in QuestionCard"
```

---

### Task 4: CLI — honor `option.value` in `QuestionInput`

**Files:**
- Modify: `packages/cli/src/tui/components/question-input.ts:6-9` and `:196-222`
- Test: `packages/cli/test/tui/components/question-input.test.ts` (create)

**Interfaces:**
- Consumes: `UserInputOption.value` (Task 1) — passed through verbatim by `app-dialogs.ts:110`.
- Produces: `QuestionInputOption` gains `value?: string`; single-select and multi-select submit return `value ?? label`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/tui/components/question-input.test.ts`:

```ts
// @summary Tests that QuestionInput returns option.value (e.g. an assetId) instead of the label when present.

import { describe, expect, test } from "bun:test";
import { QuestionInput } from "../../../../src/tui/components/question-input";

describe("QuestionInput value mapping", () => {
  test("single select returns option.value when present", () => {
    let result: string | string[] | null = "unset";
    const input = new QuestionInput(
      { question: "Pick an asset", options: [{ label: "Katana, Rusty", description: "MODEL", value: "6584600" }] },
      (value) => {
        result = value;
      },
    );

    input.handleInput("\r"); // Enter submits the focused (first) option
    expect(result).toBe("6584600");
  });

  test("single select falls back to label when value is absent", () => {
    let result: string | string[] | null = "unset";
    const input = new QuestionInput(
      { question: "Pick", options: [{ label: "Yes", description: "" }] },
      (value) => {
        result = value;
      },
    );

    input.handleInput("\r");
    expect(result).toBe("Yes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test test/tui/components/question-input.test.ts`
Expected: FAIL — first test gets `"Katana, Rusty"` (the label) instead of `"6584600"`; also a type error on the `value` property.

- [ ] **Step 3: Implement value support**

In `packages/cli/src/tui/components/question-input.ts`:

1. Add `value` to the option interface (lines 6-9):

```ts
export interface QuestionInputOption {
  label: string;
  description: string;
  value?: string;
}
```

2. In `submit()`, change the multi-select mapping (line 201):

```ts
.map((idx) => this.opts[idx]?.value ?? this.opts[idx]?.label)
```

3. In `submit()`, change the single-select result (line 221):

```ts
this.onResult(this.opts[this.selectedIndex].value ?? this.opts[this.selectedIndex].label);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test test/tui/components/question-input.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the cli package**

Run: `cd packages/cli && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors. (`app-dialogs.ts:110` passes `question.options`, which now structurally includes the optional `value`.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/tui/components/question-input.ts packages/cli/test/tui/components/question-input.test.ts
git commit -m "feat(cli): honor user-input option value in QuestionInput"
```

---

### Task 5: Sidecar — `overdaresearch` selectable flag + picker build

**Files:**
- Modify: `apps/overdare-ai-agent/sidecar/src/tools/rag/render.ts` (export `normalizeAssetForRender`)
- Modify: `apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts:1-4`, `:67-75`, `:128-138`
- Test: `apps/overdare-ai-agent/sidecar/test/tools/overdaresearch-select.test.ts` (create)

**Interfaces:**
- Consumes: `requestToolUserInput` from `@diligent/runtime`; `normalizeAssetForRender` from `./render`; `UserInputRequest` shape from Task 1.
- Produces: `overdaresearch` parameter `selectable?: boolean`. When `source === "assets"` and `selectable` is true: 0 results → `"No results found."`; 1 result → returns that asset's id; ≥2 → asks the user and returns the chosen `assetId`.

- [ ] **Step 1: Export the normalizer from `render.ts`**

In `apps/overdare-ai-agent/sidecar/src/tools/rag/render.ts`, add the `export` keyword to the existing `normalizeAssetForRender` function declaration (currently `function normalizeAssetForRender(...)`):

```ts
export function normalizeAssetForRender(raw: Partial<AssetResult>): AssetResult {
```

- [ ] **Step 2: Write the failing test**

Create `apps/overdare-ai-agent/sidecar/test/tools/overdaresearch-select.test.ts`:

```ts
// @summary Tests overdaresearch selectable asset flow: 0/1/many result branches and answer→assetId mapping.

import { afterEach, describe, expect, test } from "bun:test";
import type { UserInputRequest, UserInputResponse } from "@diligent/protocol";
import { createStudioBundledToolProviders } from "../../src/tools";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockRagFetch(results: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results, totalCount: results.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

const ctx = { toolCallId: "t", signal: new AbortController().signal, abort: () => {} };

function asset(id: string, title: string) {
  return {
    text: `${title} model`,
    score: 0.9,
    title,
    keywords: [title],
    assetId: id,
    assetType: "MODEL",
    categoryId: "WEAPON",
    subCategoryId: "WEAPON_MELEE",
    thumbnailUrl: `https://assets.example/${id}.png`,
    price: "100",
  };
}

async function searchTool(host: { approve?: () => Promise<"once">; ask?: (r: UserInputRequest) => Promise<UserInputResponse> }) {
  const providers = createStudioBundledToolProviders({ cwd: "/tmp/project" });
  const provider = providers.find((p) => p.id === "@overdare/rag-tools")!;
  const tools = await provider.createTools({ cwd: "/tmp/project", host });
  return tools.find((t) => t.name === "overdaresearch")!;
}

describe("overdaresearch selectable", () => {
  test("many results: asks the user and returns the chosen assetId", async () => {
    mockRagFetch([asset("111", "Katana A"), asset("222", "Katana B")]);
    let seen: UserInputRequest | undefined;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async (r) => {
        seen = r;
        return { answers: { [r.questions[0].id]: "222" } };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(seen?.questions[0].display).toBe("asset");
    expect(seen?.questions[0].options.map((o) => o.value)).toEqual(["111", "222"]);
    expect(seen?.questions[0].options[0].asset?.thumbnailUrl).toBe("https://assets.example/111.png");
    expect(result.output).toContain("222");
  });

  test("single result: auto-selects without asking", async () => {
    mockRagFetch([asset("333", "Only Katana")]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toContain("333");
  });

  test("no results: returns not-found without asking", async () => {
    mockRagFetch([]);
    let asked = false;
    const tool = await searchTool({
      approve: async () => "once",
      ask: async () => {
        asked = true;
        return { answers: {} };
      },
    });

    const result = await tool.execute({ query: "katana", source: "assets", topK: 8, selectable: true }, ctx);

    expect(asked).toBe(false);
    expect(result.output).toBe("No results found.");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/overdare-ai-agent/sidecar && bun test test/tools/overdaresearch-select.test.ts`
Expected: FAIL — `selectable` is rejected by the params schema / not handled; `ask` is never called.

- [ ] **Step 4: Add the `selectable` parameter**

In `apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts`, update the import on line 2 and the `parameters` object (lines 67-75):

```ts
import { type RuntimeToolHost, requestToolApproval, requestToolUserInput } from "@diligent/runtime";
```

```ts
export const parameters = z.object({
  query: z.string().describe("Search query for OVERDARE (English only)"),
  source: z
    .enum(["docs", "code", "assets"])
    .describe(
      "docs = API references and guides. code = working Lua implementation examples and patterns. assets = asset catalog search with asset metadata fields.",
    ),
  topK: z.number().int().min(1).max(10).describe("Number of results to return"),
  selectable: z
    .boolean()
    .optional()
    .describe(
      "Assets only. When true and 2+ assets match, ask the user to pick one and return the chosen assetId; exactly 1 match auto-selects; 0 matches returns not-found. Use when the user should choose a specific asset.",
    ),
});
```

- [ ] **Step 5: Add the picker helper and branch**

In `apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts`, add the import for the normalizer near the top (after line 4):

```ts
import { buildSearchRender, normalizeAssetForRender } from "./render";
```

(Replace the existing `import { buildSearchRender } from "./render";` line.)

Add this helper above `export async function execute` (e.g. after line 46):

```ts
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
```

Then, inside `execute()`, in the `if (args.source === "assets")` block (lines 128-138), insert the selectable branch **before** the existing `return`:

```ts
if (args.source === "assets") {
  const rawAssets = results.filter(isAssetResult);
  const assetResults = rawAssets.map(normalizeAssetResult);

  if (args.selectable) {
    if (rawAssets.length === 0) {
      return { output: "No results found.", metadata: { resultCount: 0 } };
    }
    if (rawAssets.length === 1) {
      const only = normalizeAssetForRender(rawAssets[0]);
      return {
        output: `Selected asset: ${only.title} (assetId: ${only.assetId})`,
        metadata: { resultCount: 1, assetId: only.assetId },
      };
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/overdare-ai-agent/sidecar && bun test test/tools/overdaresearch-select.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the existing RAG tests (no regressions)**

Run: `cd apps/overdare-ai-agent/sidecar && bun test test/tools/rag.test.ts test/tools/rag-render.test.ts`
Expected: PASS — non-selectable search and render behavior unchanged.

- [ ] **Step 8: Typecheck the sidecar package**

Run: `cd apps/overdare-ai-agent/sidecar && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/overdare-ai-agent/sidecar/src/tools/rag/overdaresearch.ts apps/overdare-ai-agent/sidecar/src/tools/rag/render.ts apps/overdare-ai-agent/sidecar/test/tools/overdaresearch-select.test.ts
git commit -m "feat(overdare): selectable asset search with user picker"
```

---

### Task 6: Docs — record the selectable asset picker

**Files:**
- Modify: `docs/guide/tool-rendering.md` (append a short note) — or the user-input/tooling guide if one is more appropriate.

**Interfaces:**
- Consumes: nothing. Documentation only.

- [ ] **Step 1: Add the documentation note**

In `docs/guide/tool-rendering.md`, append a section:

```markdown
## Interactive asset selection

The `overdaresearch` tool accepts a `selectable` flag (assets source only). When
set and two or more assets match, the tool asks the user to pick one through the
`request_user_input` channel and returns the chosen `assetId`; exactly one match
auto-selects and zero matches returns "No results found." The picker is rendered
from `UserInputQuestion.display: "asset"`, where each option carries `value`
(the `assetId`) and `asset` (thumbnail/price) fields. Asset visuals are built
server-side and never enter the model context.
```

- [ ] **Step 2: Lint the docs**

Run: `bunx biome check docs/guide/tool-rendering.md`
Expected: no errors (or run the repo's standard format command if biome reformats).

- [ ] **Step 3: Commit**

```bash
git add docs/guide/tool-rendering.md
git commit -m "docs(guide): document selectable asset search"
```

---

## Final Verification

- [ ] **Run the full affected test suites**

```bash
cd packages/protocol && bun test
cd ../web && bun test test/client/components/components.test.tsx
cd ../cli && bun test test/tui/components/question-input.test.ts
cd ../../apps/overdare-ai-agent/sidecar && bun test test/tools
```

Expected: all green.

- [ ] **Confirm the pre-commit hook passes on the final commit** (biome lint + tsc across packages already ran per task; the final commit's hook output should show ✔️ lint and ✔️ typecheck).

## Self-Review Notes (coverage vs spec)

- Protocol `value`/`asset`/`display` → Task 1.
- Answer→`value` mapping (web + cli) → Task 3 (web), Task 4 (cli).
- `overdaresearch` `selectable` + 0/1/≥2 branching + server-side picker build → Task 5.
- `QuestionCard` asset-grid variant → Task 3.
- Shared `AssetTile`/`AssetThumbnail` reuse between gallery and picker → Task 2.
- CLI numbered list with price/type → satisfied by Task 5 setting `description = "<assetType> · <price>"` (rendered by the existing `QuestionInput` desc column) + Task 4 value return.
- Read-only `asset_gallery` block retained for non-interactive search → unchanged (no task needed; Task 2 only swaps its thumbnail component).
- Cancellation path → Task 5 `selectAsset` returns `"[Cancelled by user]"` on empty answer.
- Edge: `selectable` on non-asset source → ignored (branch is inside `source === "assets"`), as documented in Task 5's param description and Task 6.
