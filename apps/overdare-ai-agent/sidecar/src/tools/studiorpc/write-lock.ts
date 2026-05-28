// @summary Async mutex that serializes mutating Studio RPC tool executions to prevent concurrent write conflicts.

export type WriteLock = {
  acquire(): Promise<() => void>;
};

export function createWriteLock(): WriteLock {
  let tail = Promise.resolve();

  function acquire(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = tail;
    tail = tail.then(() => gate);
    return ready.then(() => release);
  }

  return { acquire };
}
