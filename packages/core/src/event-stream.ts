export class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(value: IteratorResult<T>) => void> = [];
  private isDone = false;
  private resultValue: R | undefined;
  private resultResolve!: (value: R) => void;
  private resultReject!: (error: Error) => void;
  private resultPromise: Promise<R>;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.resultPromise = new Promise<R>((resolve, reject) => {
      this.resultResolve = resolve;
      this.resultReject = reject;
    });
  }

  push(event: T): void {
    if (this.isDone) return;
    if (this.isComplete(event)) {
      this.isDone = true;
      try {
        this.resultValue = this.extractResult(event);
        this.resultResolve(this.resultValue);
      } catch (err) {
        this.resultReject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
    if (this.isDone) {
      for (const resolve of this.waiting) {
        resolve({ value: undefined as T, done: true });
      }
      this.waiting = [];
    }
  }

  end(result: R): void {
    if (this.isDone) return;
    this.isDone = true;
    this.resultValue = result;
    this.resultResolve(result);
    for (const resolve of this.waiting) {
      resolve({ value: undefined as T, done: true });
    }
    this.waiting = [];
  }

  error(err: Error): void {
    if (this.isDone) return;
    this.isDone = true;
    this.resultReject(err);
    for (const resolve of this.waiting) {
      resolve({ value: undefined as T, done: true });
    }
    this.waiting = [];
  }

  result(): Promise<R> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.isDone) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}
