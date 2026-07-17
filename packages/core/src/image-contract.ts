// @summary Public image transformation policy and injected local-image loader boundary

export type { LocalImageLoader } from "./llm/image-io";
export { downscaleImageIfNeeded, withImageDownscaling } from "./llm/image-resize";
