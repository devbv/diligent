# ui-generator eval plan

Purpose: verify that the three findings added to `ui-generator` (2026-07-03) actually
change agent behavior for the better — not just that they read well. This is a
skill-creator "improving an existing skill" eval: run each test prompt twice (new skill
vs. old skill) and compare.

## What changed (the hypotheses under test)

1. **Attach to the existing owner** — read the controller/server script that already owns
   the screen and let it drive new UI; hang UI off the existing screen root instead of a
   new floating `ScreenGui`.
2. **Bind provided assets** — asset names / `ovdrassetid://` / atlas cell offsets / image
   sizes get wired into `Image`, `ImageRectOffset`, `ImageRectSize`, button images — not
   left unbound.
3. **Visual pre-response check** — before reporting done, scan for text overlap, frame
   overflow, wrong DisplayOrder/ZIndex, and reserved joystick/jump/action collisions.

## Prerequisite: run this where Studio is live

These tests only mean something if the sub-agents can actually build UI. That requires the
**OVERDARE AI agent environment with the `studiorpc_*` MCP connected and a running Studio
instance**. A plain Claude Code session without those tools cannot execute the skill — the
agents will only *describe* intentions, which does not test the hypotheses. Do not run this
plan in an environment where `studiorpc_level_browse` / `studiorpc_instance_upsert` are
unavailable.

## Baseline (old skill)

Before the 2026-07-03 edits, snapshot the pre-edit skill so the baseline runs against it:

```bash
# from the repo, at the commit BEFORE the findings were added
git show <pre-edit-commit>:apps/overdare-ai-agent/bootstrap/skills/ui-generator/SKILL.md
```

Copy the whole pre-edit `ui-generator/` tree into `ui-generator-workspace/skill-snapshot/`
and point the baseline sub-agent at the snapshot. New skill = current `ui-generator/`.

## Test prompts

Each prompt targets one hypothesis and mirrors a real request from the session research.
Every prompt needs a **starting level** that already contains the relevant existing UI /
controller, otherwise "attach to the owner" and "reuse existing root" have nothing to test.
Prepare a small fixture level (or reuse a real game level) with, at minimum:

- a `StarterGui` HUD screen driven by an existing `LocalScript` controller,
- one asset (or atlas sheet) available in the asset manager whose id/offsets are known.

Prompts (as a user would actually type them):

| id | targets | prompt |
|---|---|---|
| `attach-to-owner` | #1 | "지금 라운드 HUD 관리하는 스크립트 밑에, 홀드 타임 라벨이랑 레벨 진행 바를 RoundStatusPanel 아래에 붙여줘. 동적 값만 코드로 갱신." |
| `bind-atlas-asset` | #2 | "상점 버튼 아이콘을 이 아틀라스로 바꿔줘. assetid는 ovdrassetid://34857100, 셀 offset (0,128), 셀 크기 128x128." |
| `visual-overflow` | #3 | "킬로그를 우측 상단에 추가하고, 이름 길어도 프레임 밖으로 안 넘치게 해줘. 조이스틱/점프 버튼이랑 안 겹치게." |
| `full-hud-realistic` | #1+#2+#3 | "출석부 팝업 만들어줘. 슬롯 아이콘은 에셋매니저 BG_Attendance 쓰고, 기존 로비 컨트롤러에서 열리게 연결해줘." |

Keep prompts in the user's own language — realism is the point of the eval.

## Assertions (objectively checkable per run)

`attach-to-owner`:
- No new `ScreenGui` created when a suitable screen root already exists.
- New UI parented under the existing screen root / target panel.
- The existing owning script is read and extended (not a second competing script driving the
  same labels).

`bind-atlas-asset`:
- The target `ImageButton`/`ImageLabel` has `Image` set to the given `ovdrassetid://`.
- `ImageRectOffset` = (0,128) and `ImageRectSize` = (128,128) are actually set.
- Final report names the asset id that was bound.

`visual-overflow`:
- Kill-log label uses wrapping/truncation so long names stay inside the frame
  (no reliance on `ClipsDescendants=false` to hide overflow).
- Kill-log position does not overlap the reserved joystick/jump/action regions.
- Final response mentions a visual/overlap check (or flags what couldn't be verified).

`full-hud-realistic`:
- Assets bound (as in `bind-atlas-asset`).
- Popup opened via the existing lobby controller, not a fresh standalone script.
- Pre-response check reported.

Assertions the *old* skill is expected to miss (that's the signal we want): asset binding
left incomplete, a new floating `ScreenGui`/second script instead of reusing the owner, and
no visual-overflow check in the completion report.

## How to run (skill-creator flow)

1. Save the prompts to `ui-generator/evals/evals.json` (schema in skill-creator
   `references/schemas.md`).
2. For each prompt, spawn **two** sub-agents in the same turn: one pointed at the current
   `ui-generator/`, one at `skill-snapshot/`. Save outputs to
   `ui-generator-workspace/iteration-1/eval-<id>/{with_skill,old_skill}/`.
3. Capture `total_tokens` / `duration_ms` from each task notification into `timing.json`.
4. Grade each run against the assertions above → `grading.json` (fields: `text`, `passed`,
   `evidence`). Prefer a script for the property checks (read back the instance tree and
   assert on `Image`/`ImageRectOffset`/`ImageRectSize`/parent path).
5. Aggregate: `python -m scripts.aggregate_benchmark ui-generator-workspace/iteration-1
   --skill-name ui-generator`.
6. Launch the viewer (`eval-viewer/generate_review.py`) so a human can eyeball the actual
   UI outputs side by side, then read `feedback.json`.

## What "better" looks like

The new skill should raise the pass rate on binding/owner/overflow assertions without
inflating tokens or time much. If the new skill passes those where the old one fails, the
edits earned their place. If both pass or both fail, the edit isn't pulling its weight —
either the prompt doesn't exercise it or the wording needs to be sharper.
