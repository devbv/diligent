// @summary Shared minute clock for message timestamps without one timer per rendered message

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let currentNow = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  currentNow = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    currentNow = Date.now();
    timer = setInterval(tick, 60_000);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return currentNow;
}

export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
