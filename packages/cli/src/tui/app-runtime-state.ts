// @summary Renderer-agnostic runtime state for the CLI TUI orchestration layer

import type { PendingSteer, Mode as ProtocolMode, RequestId, ThinkingEffort } from "@diligent/protocol";

export interface PendingTurnState {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class AppRuntimeState {
  isProcessing = false;
  currentThreadId: string | null = null;
  pendingTurn: PendingTurnState | null = null;
  activeQuestionCancel: (() => void) | null = null;
  activeUserInputResolved = false;
  activeUserInputRequestId: RequestId | null = null;
  pendingUserInputRequestIds = new Set<RequestId>();
  currentMode: ProtocolMode;
  currentEffort: ThinkingEffort;
  turnStartedAtMs: number | null = null;
  reasoningStartedAtMs: number | null = null;
  reasoningAccumulatedMs = 0;
  pendingOAuthResolve: ((result: { success: boolean; error: string | null }) => void) | null = null;
  pendingSteers: PendingSteer[] = [];
  cancelRequested = false;

  constructor(mode: ProtocolMode, effort: ThinkingEffort) {
    this.currentMode = mode;
    this.currentEffort = effort;
  }

  queuePendingSteer(steer: PendingSteer): void {
    this.pendingSteers.push(steer);
  }

  pendingSteerContents(): string[] {
    return this.pendingSteers.map((steer) => steer.content);
  }

  consumePendingSteersByIds(ids: string[]): string[] {
    return this.consumePendingSteersBy(ids, (steer) => steer.id);
  }

  consumePendingSteersByText(texts: string[]): string[] {
    return this.consumePendingSteersBy(texts, (steer) => steer.content);
  }

  private consumePendingSteersBy(values: string[], getValue: (steer: PendingSteer) => string): string[] {
    const consumed: string[] = [];
    for (const value of values) {
      const index = this.pendingSteers.findIndex((steer) => getValue(steer) === value);
      if (index === -1) continue;
      const [steer] = this.pendingSteers.splice(index, 1);
      if (steer) consumed.push(steer.content);
    }
    return consumed;
  }

  consumePendingSteersFallback(count: number): string[] {
    return this.pendingSteers.splice(0, Math.max(0, count)).map((steer) => steer.content);
  }

  drainPendingSteers(): string[] {
    const drained = this.pendingSteers.map((steer) => steer.content);
    this.pendingSteers.length = 0;
    return drained;
  }

  beginTurnTiming(): void {
    this.turnStartedAtMs = Date.now();
    this.reasoningStartedAtMs = null;
    this.reasoningAccumulatedMs = 0;
  }

  noteThinkingDelta(): void {
    if (this.reasoningStartedAtMs === null) this.reasoningStartedAtMs = Date.now();
  }

  noteTextDelta(): void {
    if (this.reasoningStartedAtMs !== null) {
      this.reasoningAccumulatedMs += Date.now() - this.reasoningStartedAtMs;
      this.reasoningStartedAtMs = null;
    }
  }

  noteMessageEnd(): void {
    if (this.reasoningStartedAtMs !== null) {
      this.reasoningAccumulatedMs += Date.now() - this.reasoningStartedAtMs;
      this.reasoningStartedAtMs = null;
    }
  }
}
