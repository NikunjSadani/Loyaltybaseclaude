/**
 * Graceful stop of the Sales Import worker (plan §10c). Cloud Run Jobs send SIGTERM and then SIGKILL after a short grace
 * (~10 s). On SIGTERM / SIGINT the worker:
 *   1. stops claiming new imports (drainImports checks the token before every claim),
 *   2. aborts the current read (the processor destroys the input stream) and RELEASES its claim — the import goes back
 *      to QUEUED with its claim token cleared and this claim not counted in `attempts` (guarded by the token, never
 *      FAILED), so the next drain picks it up at once instead of waiting for the stale-heartbeat reclaim,
 *   3. exits within WORKER_STOP_DEADLINE_MS — except while the final READY transaction is in progress (a "critical"
 *      section): that one is left to commit; if SIGKILL comes first, Postgres rolls it back whole (never half-written).
 * Imported by worker.main.ts BEFORE the heap decision, so this file imports nothing (types only).
 */

/** Forced exit this long after the first signal (Cloud Run's SIGKILL follows ~10 s after SIGTERM). */
export const WORKER_STOP_DEADLINE_MS = 8_000;
/** Exit code of a forced (deadline) exit: 128 + SIGTERM. A drain that finishes its release in time exits 0. */
export const WORKER_STOP_FORCED_EXIT_CODE = 143;

/** Thrown inside a run when a stop was requested: the processor releases the claim instead of failing the import. */
export class WorkerStoppingError extends Error {
  constructor() {
    super('sales-import worker is stopping');
  }
}

export class WorkerStop {
  private why: string | null = null;
  private readonly listeners = new Set<(reason: string) => void>();
  private critical = 0;

  get requested(): boolean {
    return this.why !== null;
  }

  get reason(): string | null {
    return this.why;
  }

  /** Idempotent: the first call wins and notifies every listener once. */
  request(reason: string): void {
    if (this.why !== null) return;
    this.why = reason;
    for (const l of [...this.listeners]) {
      try {
        l(reason);
      } catch {
        /* a listener must never stop the others */
      }
    }
  }

  /** Called on stop (immediately when already requested). Returns an unsubscribe. */
  onStop(cb: (reason: string) => void): () => void {
    if (this.why !== null) {
      cb(this.why);
      return () => undefined;
    }
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** The final READY transaction: never force-exited (see installWorkerSignals). */
  enterCritical(): void {
    this.critical++;
  }

  exitCritical(): void {
    this.critical = Math.max(0, this.critical - 1);
  }

  get inCritical(): boolean {
    return this.critical > 0;
  }
}

export interface WorkerSignalDeps {
  stop: WorkerStop;
  on: (signal: 'SIGTERM' | 'SIGINT', cb: () => void) => void;
  exit: (code: number) => void;
  log: (line: string) => void;
  deadlineMs?: number;
}

/**
 * SIGTERM / SIGINT → stop requested + a deadline. At the deadline the process exits unless the READY transaction is in
 * progress (then it is left to finish; the platform's SIGKILL is the backstop and the transaction is atomic). The timer
 * is unref'd so a drain that finishes first exits normally.
 */
export function installWorkerSignals(deps: WorkerSignalDeps): void {
  const deadlineMs = deps.deadlineMs ?? WORKER_STOP_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    deps.log(JSON.stringify({ msg: 'sales-import worker: signal received; stopping (no new claims, releasing the current import)', signal }));
    deps.stop.request(signal);
    if (timer) return;
    timer = setTimeout(() => {
      if (deps.stop.inCritical) {
        deps.log(JSON.stringify({ msg: 'sales-import worker: stop deadline reached with the READY write in progress; letting it commit', signal }));
        return;
      }
      deps.log(JSON.stringify({ msg: 'sales-import worker: stop deadline reached; exiting', signal, deadlineMs }));
      deps.exit(WORKER_STOP_FORCED_EXIT_CODE);
    }, deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  };
  deps.on('SIGTERM', () => onSignal('SIGTERM'));
  deps.on('SIGINT', () => onSignal('SIGINT'));
}

/** The worker loop: claim → process until nothing is claimable or a stop is requested. Returns the number processed. */
export async function drainImports<R>(
  proc: { claimNext(): Promise<R | null>; processClaimed(row: R, stop: WorkerStop): Promise<void> },
  stop: WorkerStop,
): Promise<number> {
  let processed = 0;
  while (!stop.requested) {
    const row = await proc.claimNext();
    if (!row) break;
    // A row claimed while the signal arrived is still handed over: its run sees the stop and releases it at once.
    await proc.processClaimed(row, stop);
    processed++;
  }
  return processed;
}
