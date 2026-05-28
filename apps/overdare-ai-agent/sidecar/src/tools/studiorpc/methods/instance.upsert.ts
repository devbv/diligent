// @summary Defines batched argument schemas for instance upserts.
import { z } from "zod";
import {
  classPropertiesSchemas,
  classPropertyShapes,
  instanceClassEnum,
  instancePropertiesSchema,
  serviceClassEnum,
} from "./instance.params";

const addParams = z
  .object({
    class: instanceClassEnum,
    parentGuid: z.string(),
    name: z.string(),
    properties: instancePropertiesSchema,
  })
  .strict();

const updateParams = z
  .object({
    guid: z
      .string()
      .describe("Target instance GUID. Only for updating existing instances; do not include when creating new ones."),
    name: z.string().optional(),
    properties: instancePropertiesSchema,
  })
  .strict();

const itemParams = z
  .union([addParams, updateParams])
  .describe(
    "Each item is inferred by its fields: add uses parentGuid/class/name/properties, update uses guid/(optional name)/properties.",
  );

export const params = z
  .object({
    items: z
      .array(itemParams)
      .min(1)
      .max(20)
      .describe(
        "Batch items inferred as add or update by their fields. Do not mix adds and updates in a single call — use one call for all adds, another for all updates. Start with a small number first, then increase up to 10 if needed.",
      ),
  })
  .strict();

export const method = "instance.upsert";

export const description =
  "Upsert instances in batch. " +
  "Do not mix adds and updates in a single call — use one call for all adds, another for all updates. " +
  "Start with a small number of items first, then increase up to 10 if needed. " +
  "Each item is inferred by its fields: add uses parentGuid/class/name/properties, update uses guid with optional name and properties. " +
  "To create nested hierarchies, add the parent first so its GUID is returned, then add children using that GUID as parentGuid in subsequent items. " +
  "Services (Workspace, Lighting, Atmosphere, Players, StarterPlayer, MaterialService, etc.) are singletons — they cannot be added, only updated by guid. " +
  "To reparent an existing instance (change its hierarchy), use instance.move instead of delete + re-add. ";

export type InstanceUpsertAddArgs = z.infer<typeof addParams>;
export type InstanceUpsertUpdateArgs = z.infer<typeof updateParams>;
export type InstanceUpsertItemArgs = InstanceUpsertAddArgs | InstanceUpsertUpdateArgs;
export type InstanceUpsertArgs = z.infer<typeof params>;

export function isUpdateItem(value: InstanceUpsertItemArgs): value is InstanceUpsertUpdateArgs {
  return "guid" in value && typeof value.guid === "string";
}

/**
 * Validates properties of each item against the class-specific schema for precise error messages.
 * Falls back to the raw ZodError if no class-specific issues are found.
 */
export function parseArgs(value: Record<string, unknown>): InstanceUpsertArgs {
  const result = params.safeParse(value);
  if (result.success) return result.data;

  // Attempt class-aware re-validation for actionable error messages
  const items = Array.isArray(value.items) ? (value.items as Record<string, unknown>[]) : [];
  const details: string[] = [];
  const serviceClasses = new Set<string>(serviceClassEnum.options);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    const cls = typeof item.class === "string" ? item.class : undefined;
    if (cls && serviceClasses.has(cls)) {
      details.push(`  [items[${i}]] "${cls}" is a Service — it cannot be added, only updated by guid.`);
      continue;
    }
    validateItemProperties(item, `items[${i}]`, details);
  }

  if (details.length > 0) {
    throw new Error(details.join("\n"));
  }
  // No class-specific issues found — throw the original zod error
  throw result.error;
}

/**
 * For update items (no `class` field), find the best-matching class by key overlap
 * so we can validate against the right schema and give precise errors.
 */
function inferClassFromProperties(props: Record<string, unknown>): string | undefined {
  const propKeys = Object.keys(props);
  if (propKeys.length === 0) return undefined;

  let bestClass: string | undefined;
  let bestOverlap = 0;

  for (const [name, shapes] of Object.entries(classPropertyShapes)) {
    const shapeKeys = Object.keys(shapes);
    let overlap = 0;
    for (const key of propKeys) {
      if (shapeKeys.includes(key)) overlap++;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestClass = name;
    }
  }

  return bestClass;
}

// ---------------------------------------------------------------------------
// Mobile UI overlap warnings (reference resolution: 1386×640)
//
// Validation policy:
// - ZIndex is interpreted in 100-point bands.
// - Only elements in the same band are checked against each other for UI-to-UI overlap.
// - Band 0 (0-99) is the normal mobile HUD band and is checked against reserved system HUD zones.
// - Higher bands are treated as overlay/debug layers and may intentionally cover the full screen
//   (for example loading screens, modal dimmers, tutorial blockers).
// ---------------------------------------------------------------------------

const SCREEN_W = 1386;
const SCREEN_H = 640;

/** Default jump button layout — the canonical mobile reference point. */
const JUMP_BUTTON = {
  anchorX: 1,
  anchorY: 1,
  posScaleX: 1,
  posOffsetX: -140,
  posScaleY: 1,
  posOffsetY: -70,
  sizeScaleX: 0,
  sizeOffsetX: 180,
  sizeScaleY: 0,
  sizeOffsetY: 180,
} as const;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Classes that resolve a rect (for parent propagation and overlap checks). */
const GUI_OBJECT_CLASSES = new Set(["Frame", "ImageButton", "ImageLabel", "TextButton", "TextLabel", "ScrollingFrame"]);

/** Returns true if the node is fully transparent (skip from all checks). */
function isFullyTransparent(node: Record<string, unknown>): boolean {
  const t = node.BackgroundTransparency;
  return typeof t === "number" && t >= 1;
}

/** Classes that warn when too small for comfortable tap targets. */
const MIN_TAP_SIZE = 60;
const RECOMMENDED_TAP_SIZE = 80;
const TAP_TARGET_CLASSES = new Set(["ImageButton", "TextButton"]);

/**
 * Resolves a GuiObject node to an absolute screen-space rect.
 * `parentRect` provides the absolute bounds of the parent container
 * so that Scale values are computed relative to the parent size.
 */
function resolveRect(props: Record<string, unknown>, parentRect: Rect): Rect | undefined {
  const pos = props.Position as
    | { X?: { Scale?: number; Offset?: number }; Y?: { Scale?: number; Offset?: number } }
    | undefined;
  const size = props.Size as
    | { X?: { Scale?: number; Offset?: number }; Y?: { Scale?: number; Offset?: number } }
    | undefined;
  if (!pos && !size) return undefined;

  const parentW = parentRect.right - parentRect.left;
  const parentH = parentRect.bottom - parentRect.top;

  const anchor = props.AnchorPoint as { X?: number; Y?: number } | undefined;
  const ax = anchor?.X ?? 0;
  const ay = anchor?.Y ?? 0;

  // Position is relative to the parent's top-left corner
  const px = parentRect.left + (pos?.X?.Scale ?? 0) * parentW + (pos?.X?.Offset ?? 0);
  const py = parentRect.top + (pos?.Y?.Scale ?? 0) * parentH + (pos?.Y?.Offset ?? 0);
  const sw = (size?.X?.Scale ?? 0) * parentW + (size?.X?.Offset ?? 0);
  const sh = (size?.Y?.Scale ?? 0) * parentH + (size?.Y?.Offset ?? 0);

  if (sw <= 0 || sh <= 0) return undefined;

  const left = px - ax * sw;
  const top = py - ay * sh;
  return { left, top, right: left + sw, bottom: top + sh };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const SCREEN_RECT: Rect = { left: 0, top: 0, right: SCREEN_W, bottom: SCREEN_H };

/** Native HUD area at top-left corner that must not be obscured. */
const NATIVE_HUD: Rect = { left: 0, top: 0, right: 210, bottom: 70 };

/** Mobile joystick area at bottom-left corner (anchor 0,1 — 300×300). */
const JOYSTICK: Rect = { left: 0, top: SCREEN_H - 300, right: 300, bottom: SCREEN_H };

/** Left/right safe area insets for device notch and OS menus (52px each side). */
const SAFE_INSET = 40;
const LEFT_INSET: Rect = { left: 0, top: 0, right: SAFE_INSET, bottom: SCREEN_H };
const RIGHT_INSET: Rect = { left: SCREEN_W - SAFE_INSET, top: 0, right: SCREEN_W, bottom: SCREEN_H };

interface ReservedZone {
  label: string;
  rect: Rect;
}

function buildReservedZones(): ReservedZone[] {
  const j = JUMP_BUTTON;
  const px = j.posScaleX * SCREEN_W + j.posOffsetX;
  const py = j.posScaleY * SCREEN_H + j.posOffsetY;
  const sw = j.sizeScaleX * SCREEN_W + j.sizeOffsetX;
  const sh = j.sizeScaleY * SCREEN_H + j.sizeOffsetY;
  const left = px - j.anchorX * sw;
  const top = py - j.anchorY * sh;

  return [
    { label: "mobile jump button", rect: { left, top, right: left + sw, bottom: top + sh } },
    { label: "mobile HUD", rect: NATIVE_HUD },
    { label: "mobile joystick", rect: JOYSTICK },
    { label: "left safe area (notch/OS menu)", rect: LEFT_INSET },
    { label: "right safe area (notch/OS menu)", rect: RIGHT_INSET },
  ];
}

type OvdrjmNode = Record<string, unknown> & { LuaChildren?: unknown };

/** Classes whose parent rect is the full screen (they are screen-level containers). */
const SCREEN_GUI_CLASSES = new Set(["ScreenGui", "StarterGui"]);

/**
 * Walks the full .ovdrjm tree after writes and reports every GuiObject
 * whose resolved rect overlaps the default mobile jump button area.
 * Parent rects are propagated so Scale values resolve relative to the
 * actual parent container, not always the screen.
 */
interface GuiEntry {
  name: string;
  cls: string;
  guid: string;
  rect: Rect;
  zIndex: number;
  band: number;
  isFullscreenOverlay: boolean;
  /** Full guid of this node (for ancestry checks). */
  fullGuid: string;
  /** Set of ancestor full guids from root to this node. */
  ancestors: Set<string>;
}

function getZIndex(node: Record<string, unknown>): number {
  const raw = node.ZIndex;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function getZBand(zIndex: number): number {
  if (zIndex <= 0) return 0;
  return Math.floor(zIndex / 100);
}

function rectWidth(rect: Rect): number {
  return rect.right - rect.left;
}

function rectHeight(rect: Rect): number {
  return rect.bottom - rect.top;
}

function rectArea(rect: Rect): number {
  return Math.max(0, rectWidth(rect)) * Math.max(0, rectHeight(rect));
}

function isFullscreenOverlay(rect: Rect): boolean {
  const widthCoverage = rectWidth(rect) / SCREEN_W;
  const heightCoverage = rectHeight(rect) / SCREEN_H;
  const areaCoverage = rectArea(rect) / rectArea(SCREEN_RECT);
  return widthCoverage >= 0.9 && heightCoverage >= 0.9 && areaCoverage >= 0.85;
}

function describeBand(band: number): string {
  const min = band * 100;
  const max = min + 99;
  return `ZIndex band ${band} (${min}-${max})`;
}

export interface UiDiagnostics {
  warnings: string[];
  info: string[];
}

export function collectUiDiagnostics(root: OvdrjmNode): UiDiagnostics {
  const warnings: string[] = [];
  const info: string[] = [];
  const zones = buildReservedZones();
  const buttons: GuiEntry[] = [];
  const allGui: GuiEntry[] = [];
  walkNodes(root, SCREEN_RECT, zones, warnings, info, buttons, allGui, new Set());

  // Check button-to-button overlaps (warning)
  for (let i = 0; i < buttons.length; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      const a = buttons[i];
      const b = buttons[j];
      if (a.band !== b.band) continue;
      if (a.isFullscreenOverlay || b.isFullscreenOverlay) continue;
      if (rectsOverlap(a.rect, b.rect)) {
        warnings.push(
          `"${a.name}" (${a.cls} ${a.guid}…) overlaps "${b.name}" (${b.cls} ${b.guid}…) — ` +
            `${describeBand(a.band)}, ` +
            `(${Math.round(a.rect.left)},${Math.round(a.rect.top)})-(${Math.round(a.rect.right)},${Math.round(a.rect.bottom)}) ` +
            `vs (${Math.round(b.rect.left)},${Math.round(b.rect.top)})-(${Math.round(b.rect.right)},${Math.round(b.rect.bottom)}).`,
        );
      }
    }
  }

  // Check all GUI-to-GUI overlaps for unrelated elements (info)
  // Skip pairs that are ancestor-descendant or already reported as button-to-button warnings.
  const buttonGuids = new Set(buttons.map((b) => b.fullGuid));
  for (let i = 0; i < allGui.length; i++) {
    for (let j = i + 1; j < allGui.length; j++) {
      const a = allGui[i];
      const b = allGui[j];
      // Skip if both are buttons (already reported as warning)
      if (buttonGuids.has(a.fullGuid) && buttonGuids.has(b.fullGuid)) continue;
      // Skip ancestor-descendant pairs
      if (a.ancestors.has(b.fullGuid) || b.ancestors.has(a.fullGuid)) continue;
      // Skip cross-band comparisons; different bands intentionally separate base HUD from overlays/debug layers.
      if (a.band !== b.band) continue;
      // Skip fullscreen overlay backdrops/dimmers inside overlay bands.
      if (a.isFullscreenOverlay || b.isFullscreenOverlay) continue;
      if (rectsOverlap(a.rect, b.rect)) {
        info.push(
          `"${a.name}" (${a.cls} ${a.guid}…) overlaps "${b.name}" (${b.cls} ${b.guid}…) — ` +
            `both are in ${describeBand(a.band)}; if unintentional, consider adjusting their positions.`,
        );
      }
    }
  }

  return { warnings, info };
}

function walkNodes(
  node: OvdrjmNode,
  parentRect: Rect,
  zones: ReservedZone[],
  warnings: string[],
  info: string[],
  buttons: GuiEntry[],
  allGui: GuiEntry[],
  ancestors: Set<string>,
  insideScreenGui = false,
): void {
  const cls = typeof node.InstanceType === "string" ? node.InstanceType : undefined;
  const fullGuid = typeof node.ActorGuid === "string" ? node.ActorGuid : "";

  let childRect = parentRect;
  let childInsideScreenGui = insideScreenGui;

  if (cls && SCREEN_GUI_CLASSES.has(cls)) {
    childRect = SCREEN_RECT;
    childInsideScreenGui = true;
  } else if (cls && GUI_OBJECT_CLASSES.has(cls)) {
    const rect = resolveRect(node, parentRect);
    if (rect) {
      childRect = rect;
      const name = typeof node.Name === "string" ? node.Name : cls;
      const guid = fullGuid.slice(0, 8) || "?";
      const w = Math.round(rect.right - rect.left);
      const h = Math.round(rect.bottom - rect.top);
      const zIndex = getZIndex(node);
      const band = getZBand(zIndex);
      const entry: GuiEntry = {
        name,
        cls,
        guid,
        rect,
        zIndex,
        band,
        isFullscreenOverlay: band > 0 && isFullscreenOverlay(rect),
        fullGuid,
        ancestors: new Set(ancestors),
      };

      // Only validate nodes that are descendants of a ScreenGui.
      // Nodes under ReplicatedStorage etc. are templates cloned at runtime
      // into a different parent — their Scale values resolve against the
      // wrong parent rect here, producing false-positive overlaps.
      if (!isFullyTransparent(node) && childInsideScreenGui) {
        allGui.push(entry);

        // Reserved zone overlap check: only the base HUD band is blocked from system UI areas.
        if (band === 0) {
          for (const zone of zones) {
            if (rectsOverlap(rect, zone.rect)) {
              const r = zone.rect;
              warnings.push(
                `"${name}" (${cls} ${guid}…) overlaps the ${zone.label} area ` +
                  `(${Math.round(rect.left)},${Math.round(rect.top)})-(${Math.round(rect.right)},${Math.round(rect.bottom)}) ` +
                  `vs ${zone.label} (${r.left},${r.top})-(${r.right},${r.bottom}) at ${SCREEN_W}×${SCREEN_H} in ${describeBand(band)}. ` +
                  `If this is a layout container, set BackgroundTransparency to 1. Use ZIndex 100+ only for intentional overlays such as loading screens or modal blockers.`,
              );
            }
          }
        }

        // Tap target size check (buttons only)
        if (cls && TAP_TARGET_CLASSES.has(cls)) {
          buttons.push(entry);
          if (w < MIN_TAP_SIZE || h < MIN_TAP_SIZE) {
            warnings.push(
              `"${name}" (${cls} ${guid}…) is too small for a tap target (${w}×${h}px, minimum ${MIN_TAP_SIZE}×${MIN_TAP_SIZE}px, recommended ${RECOMMENDED_TAP_SIZE}×${RECOMMENDED_TAP_SIZE}px).`,
            );
          } else if (w < RECOMMENDED_TAP_SIZE || h < RECOMMENDED_TAP_SIZE) {
            info.push(
              `"${name}" (${cls} ${guid}…) is below recommended tap target size (${w}×${h}px, recommended ${RECOMMENDED_TAP_SIZE}×${RECOMMENDED_TAP_SIZE}px).`,
            );
          }
        }
      }
    }
  }

  // Propagate ancestry for children
  const childAncestors = fullGuid ? new Set([...ancestors, fullGuid]) : ancestors;

  if (Array.isArray(node.LuaChildren)) {
    for (const child of node.LuaChildren) {
      if (child != null && typeof child === "object") {
        walkNodes(
          child as OvdrjmNode,
          childRect,
          zones,
          warnings,
          info,
          buttons,
          allGui,
          childAncestors,
          childInsideScreenGui,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

function validateItemProperties(item: Record<string, unknown>, path: string, details: string[]): void {
  const className = typeof item.class === "string" ? item.class : undefined;
  const props = item.properties;
  if (props == null || typeof props !== "object") return;

  const resolvedClass = className ?? inferClassFromProperties(props as Record<string, unknown>);
  if (!resolvedClass) return;

  const schema = classPropertiesSchemas.get(resolvedClass);
  if (!schema) return;

  const r = schema.safeParse(props);
  if (!r.success) {
    const label = className ? `class=${resolvedClass}` : `closest match: ${resolvedClass}`;
    for (const issue of r.error.issues) {
      const loc = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      details.push(`  [${path}.properties${loc}] (${label}) ${issue.message}`);
    }
  }
}
