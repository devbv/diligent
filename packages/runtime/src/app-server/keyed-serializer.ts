// @summary Serializes async tasks per key so same-key tasks never overlap — used to present one user-input prompt at a time.

const NOOP = (): void => {};

/**
 * Returns a `serialize(key, task)` function. Tasks sharing a key run strictly one
 * at a time, in call order; tasks with different keys run independently. A task
 * that rejects does not block later tasks with the same key.
 *
 * This prevents the app server from broadcasting overlapping user-input prompts
 * for the same thread (e.g. when the agent fans out several selectable asset
 * searches in parallel), which a single-prompt client cannot handle.
 */
export function createKeyedSerializer() {
  const tails = new Map<string, Promise<unknown>>();

  return function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(() => task());
    // Keep the chain alive (and non-rejecting) so later same-key tasks still run.
    tails.set(key, run.then(NOOP, NOOP));
    return run;
  };
}
