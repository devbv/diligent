// @summary Tracks per-session prompt hash and cache read state for cache-hit diagnostics

export class SessionCache {
  private prevCacheReadBySession = new Map<string, number>();
  private prevPromptHashesBySession = new Map<string, string[]>();
  private currPromptHashesBySession = new Map<string, string[]>();
  private promptSignatureCountBySession = new Map<string, number>();

  handleUsage(sessionId: string, usage: { cacheReadTokens: number }): void {
    const prevCacheRead = this.prevCacheReadBySession.get(sessionId) ?? 0;
    const currCacheRead = usage.cacheReadTokens;
    const turn = this.promptSignatureCountBySession.get(sessionId) ?? 0;
    const prevPromptHashes = this.prevPromptHashesBySession.get(sessionId) ?? [];
    const currPromptHashes = this.currPromptHashesBySession.get(sessionId) ?? [];
    const commonPrefix = sharedPrefixLength(prevPromptHashes, currPromptHashes);

    if (prevCacheRead - currCacheRead >= 4096) {
      this.emitPrefixCompareLog({
        sessionId,
        turn,
        prevCacheRead,
        currCacheRead,
        commonPrefix,
        currPromptHashes,
        reason: "cache_read_decreased",
      });
    }
    if (turn >= 2 && currCacheRead === 0) {
      this.emitPrefixCompareLog({
        sessionId,
        turn,
        prevCacheRead,
        currCacheRead,
        commonPrefix,
        currPromptHashes,
        reason: "turn_ge_2_cache_read_zero",
      });
    }

    this.prevCacheReadBySession.set(sessionId, currCacheRead);
  }

  handlePromptSignature(sessionId: string, hashes: string[]): void {
    const prev = this.currPromptHashesBySession.get(sessionId);
    if (prev) {
      this.prevPromptHashesBySession.set(sessionId, prev);
    }
    this.currPromptHashesBySession.set(sessionId, hashes);
    this.promptSignatureCountBySession.set(sessionId, (this.promptSignatureCountBySession.get(sessionId) ?? 0) + 1);
  }

  reset(): void {
    this.prevCacheReadBySession.clear();
    this.prevPromptHashesBySession.clear();
    this.currPromptHashesBySession.clear();
    this.promptSignatureCountBySession.clear();
  }

  private emitPrefixCompareLog(payload: {
    sessionId: string;
    turn: number;
    prevCacheRead: number;
    currCacheRead: number;
    commonPrefix: number;
    currPromptHashes: string[];
    reason: "cache_read_decreased" | "turn_ge_2_cache_read_zero";
  }): void {
    console.error(
      `[usage:prefix-compare] session=${payload.sessionId} turn=${payload.turn} prevCacheRead=${payload.prevCacheRead} currCacheRead=${payload.currCacheRead} commonPrefix=${payload.commonPrefix} currHashes=${JSON.stringify(payload.currPromptHashes)} reason=${payload.reason}`,
    );
  }
}

function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}
