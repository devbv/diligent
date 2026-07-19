// @summary Enforces one abortable root deadline plus bounded phase and cleanup races for runtime evals

export class RuntimeDeadlineError extends Error {
  constructor(
    readonly kind: "root" | "phase",
    readonly phase: string,
    readonly timeoutMs: number,
  ) {
    super(
      kind === "root" ? `Runtime task exceeded ${timeoutMs}ms.` : `Runtime ${phase} phase exceeded ${timeoutMs}ms.`,
    );
    this.name = "RuntimeDeadlineError";
  }
}

export class RuntimeDeadline {
  readonly controller = new AbortController();
  readonly started = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly timeoutMs: number) {
    this.timer = setTimeout(() => {
      this.controller.abort(new RuntimeDeadlineError("root", "execution", timeoutMs));
    }, timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.timeoutMs - (performance.now() - this.started));
  }

  async run<T>(phase: string, operation: Promise<T> | (() => Promise<T>), phaseTimeoutMs?: number): Promise<T> {
    if (this.signal.aborted) throw this.abortReason();
    const promise = typeof operation === "function" ? operation() : operation;
    const cap = phaseTimeoutMs === undefined ? this.remainingMs() : Math.min(this.remainingMs(), phaseTimeoutMs);
    if (cap <= 0) throw this.expire(phase, phaseTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          abortListener = () => reject(this.abortReason());
          this.signal.addEventListener("abort", abortListener, { once: true });
          if (phaseTimeoutMs !== undefined && phaseTimeoutMs < this.remainingMs()) {
            timer = setTimeout(() => reject(this.expire(phase, phaseTimeoutMs)), cap);
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) this.signal.removeEventListener("abort", abortListener);
    }
  }

  close(): void {
    clearTimeout(this.timer);
  }

  private expire(phase: string, phaseTimeoutMs?: number): RuntimeDeadlineError {
    const rootExpired = this.remainingMs() <= 0 || phaseTimeoutMs === undefined;
    const error = new RuntimeDeadlineError(
      rootExpired ? "root" : "phase",
      phase,
      rootExpired ? this.timeoutMs : phaseTimeoutMs,
    );
    if (!this.signal.aborted) this.controller.abort(error);
    return error;
  }

  private abortReason(): RuntimeDeadlineError {
    return this.signal.reason instanceof RuntimeDeadlineError
      ? this.signal.reason
      : new RuntimeDeadlineError("root", "execution", this.timeoutMs);
  }
}

export async function raceBounded<T>(operation: Promise<T> | (() => Promise<T>), timeoutMs: number): Promise<T> {
  const promise = typeof operation === "function" ? operation() : operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Bounded operation exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
