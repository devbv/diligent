// @summary Provider-native compaction contract — input/result types and dispatch function types
import type { Model, SystemSection } from "../types";

export interface NativeCompactionInput {
  localImageLoader?: import("../image-io").LocalImageLoader;
  model: Model;
  systemPrompt: SystemSection[];
  messages: import("../../types").Message[];
  compactionSummary?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface NativeCompactionSuccess {
  status: "ok";
  summary?: string;
  compactionSummary?: Record<string, unknown>;
}

export interface NativeCompactionUnsupported {
  status: "unsupported";
  reason?: string;
}

export type NativeCompactionResult = NativeCompactionSuccess | NativeCompactionUnsupported;

/** A function that performs provider-native compaction. */
export type NativeCompactFn = (input: NativeCompactionInput) => Promise<NativeCompactionResult>;

/** Maps provider name to its NativeCompactFn. Returns undefined if not configured. */
export type NativeCompactionLookup = (provider: string) => NativeCompactFn | undefined;
