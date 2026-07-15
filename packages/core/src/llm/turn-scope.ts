// @summary Ephemeral per-turn resource scope for provider stream state

export interface StreamTurnResource<T> {
  value: T;
  dispose: () => void | Promise<void>;
}

export interface StreamTurnScope {
  readonly turnStateRef: { value: string | undefined };
  getOrCreate<T>(key: symbol, create: () => StreamTurnResource<T>): T;
  dispose(): Promise<void>;
}

export function createStreamTurnScope(): StreamTurnScope {
  const resources = new Map<symbol, StreamTurnResource<unknown>>();
  const turnStateRef = { value: undefined as string | undefined };
  let disposePromise: Promise<void> | undefined;

  return {
    turnStateRef,
    getOrCreate<T>(key: symbol, create: () => StreamTurnResource<T>): T {
      if (disposePromise) throw new Error("Stream turn scope has been disposed");
      const existing = resources.get(key);
      if (existing) return existing.value as T;
      const resource = create();
      resources.set(key, resource as StreamTurnResource<unknown>);
      return resource.value;
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const errors: unknown[] = [];
        for (const resource of [...resources.values()].reverse()) {
          try {
            await resource.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        resources.clear();
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose stream turn scope resources");
      })();
      return disposePromise;
    },
  };
}
