// @summary Declares the Studio RPC method for capturing a screenshot of the editor viewport.
import { z } from "zod";

export const method = "game.screenshot";

export const description =
  "Capture a screenshot of the OVERDARE Studio viewport and see it directly — use this to self-check " +
  "visual results (placement, lighting, camera framing, animation state, UI layout) before reporting a " +
  "visual change done, instead of assuming success from RPC/save results alone. " +
  "GUI elements are included by default; pass includeGui: false to capture the scene only. " +
  'Currently only the "Viewport" mode is supported (defaults to "Viewport" when omitted). ' +
  "Other modes (Thumbnail / HubScreenshot / Custom with explicit size) are planned and not yet available.";

export const params = z
  .object({
    captureType: z
      .literal("Viewport")
      .optional()
      .describe('Capture mode. Currently only "Viewport" is supported. Defaults to "Viewport" when omitted.'),
    includeGui: z
      .boolean()
      .optional()
      .describe("Whether to include GUI elements in the capture. Defaults to true when omitted."),
  })
  .strict();

// Default at the RPC boundary (not via zod .default) so every call path —
// agent runtime and MCP server — sends an explicit includeGui to Studio.
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, includeGui: args.includeGui ?? true };
}

// When additional capture modes are supported, restore the discriminated-union
// schema below. It rejects mismatched `size` usage at the schema layer (instead
// of via a post-hoc refine) so models like ChatGPT can't silently keep sending
// `size` with a preset capture mode.
//
// const sizeSchema = z.object({
//   width: z.number().int().positive().describe("Image width in pixels."),
//   height: z.number().int().positive().describe("Image height in pixels."),
// });
//
// const customParams = z
//   .object({
//     captureType: z.literal("Custom").describe("Custom capture — requires an explicit `size` (width/height in pixels)."),
//     size: sizeSchema.describe('REQUIRED for "Custom" capture. Image width and height in pixels.'),
//   })
//   .strict();
//
// const presetParams = z
//   .object({
//     captureType: z
//       .enum(["Viewport", "Thumbnail", "HubScreenshot"])
//       .describe(
//         "Preset capture mode with system-defined dimensions. " +
//           'DO NOT include a "size" field for these modes — the call will be rejected.',
//       ),
//   })
//   .strict();
//
// export const params = z.preprocess(
//   (value) => {
//     if (value && typeof value === "object" && !Array.isArray(value) && !("captureType" in value)) {
//       return { ...(value as Record<string, unknown>), captureType: "Viewport" };
//     }
//     return value;
//   },
//   z.discriminatedUnion("captureType", [customParams, presetParams]),
// );
