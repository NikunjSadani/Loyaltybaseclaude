/**
 * Graceful stop of the Sales Import worker (plan §10c). Cloud Run Jobs send SIGTERM and then SIGKILL after a short grace
 * (~10 s). On SIGTERM / SIGINT the worker:
 *   1. stops claiming new imports (drainImports checks the token before every claim),
 *   2. aborts the current read (the processor destroys the input stream) and RELEASES its claim — the import goes back
 *      to QUEUED with its claim token cleared (guarded by the token, never FAILED by the stop itself), so the next drain
 *      picks it up at once instead of waiting for the stale-heartbeat reclaim. The attempt is not counted only for an
 *      early stop (processor: STOP_RESTORES_ATTEMPT_WITHIN_MS), so a file that always hits the task timeout still ends
 *      FAILED after SALES_IMPORT_MAX_ATTEMPTS,
 *   3. exits within WORKER_STOP_DEADLINE_MS with WORKER_STOP_EXIT_CODE (143) — so Cloud Run's task retry picks the
 *      handed-back import up promptly — except while the final READY transaction is in progress (a "critical" section):
 *      that one is left to commit (if SIGKILL comes first, Postgres rolls it back whole); when it ends after the
 *      deadline, a short WORKER_STOP_AFTER_CRITICAL_MS timer re-arms the forced exit.
 * Imported by worker.main.ts BEFORE the heap decision, so this file imports nothing (types only).
 */

/** Forced exit this long after the first signal (Cloud Run's SIGKILL follows ~10 s after SIGTERM). */
export const WORKER_STOP_DEADLINE_MS = 8_000;
/** Forced exit this long after a READY transaction that outlived the deadline ends. */
export const WORKER_STOP_AFTER_CRITICAL_MS = 1_000;
/** Exit code of a stopped worker (128 + SIGTERM), forced or not: a non-zero exit lets Cloud Run retry the task. */
export const WORKER_STOP_EXIT_CODE = 143;

/** What one processClaimed() run ended with. */
export type RunOutcome = 'finished' | 'released' | 'superseded';

/** Thrown inside a run when a stop was requested: the processor releases the claim instead of failing the import. */
export class WorkerStoppingError extends Error {
  constructor() {
    super('sales-import worker is stopping');
  }
}

export class WorkerStop {
  private why: string | null = null;
  private readonly listeners = new Set<(reason: string) => void>();
  private readonly criticalEndListeners = new Set<() => void>();
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

  /** Called whenever the last critical section ends. Returns an unsubscribe. */
  onCriticalEnd(cb: () => void): () => void {
    this.criticalEndListeners.add(cb);
    return () => {
      this.criticalEndListeners.delete(cb);
    };
  }

  /** The final READY transaction: never force-exited (see installWorkerSignals). */
  enterCritical(): void {
    this.critical++;
  }

  exitCritical(): void {
    if (this.critical === 0) return;
    this.critical--;
    if (this.critical > 0) return;
    for (const l of [...this.criticalEndListeners]) {
      try {
        l();
      } catch {
        /* never let a listener break the run */
      }
    }
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
 * progress; then it is left to finish, and its end re-arms a short forced exit (audit L2). The platform's SIGKILL is the
 * backstop and the transaction is atomic. Timers are unref'd so a drain that finishes first exits on its own.
 */
export function installWorkerSignals(deps: WorkerSignalDeps): void {
  const deadlineMs = deps.deadlineMs ?? WORKER_STOP_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlinePassed = false;
  const arm = (ms: number, signal: string) => {
    const t = setTimeout(() => {
      deadlinePassed = true;
      if (deps.stop.inCritical) {
        deps.log(JSON.stringify({ msg: 'sales-import worker: stop deadline reached with the READY write in progress; letting it commit', signal }));
        return;
      }
      deps.log(JSON.stringify({ msg: 'sales-import worker: stop deadline reached; exiting', signal, afterMs: ms }));
      deps.exit(WORKER_STOP_EXIT_CODE);
    }, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  };
  const onSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    deps.log(JSON.stringify({ msg: 'sales-import worker: signal received; stopping (no new claims, releasing the current import)', signal }));
    deps.stop.request(signal);
    if (timer) return;
    timer = arm(deadlineMs, signal);
  };
  deps.stop.onCriticalEnd(() => {
    if (deps.stop.requested && deadlinePassed) arm(WORKER_STOP_AFTER_CRITICAL_MS, deps.stop.reason ?? 'signal');
  });
  deps.on('SIGTERM', () => onSignal('SIGTERM'));
  deps.on('SIGINT', () => onSignal('SIGINT'));
}

export interface DrainResult {
  /** Imports whose run wrote a result (READY / NEEDS_MAPPING / FAILED). */
  finished: number;
  /** Imports handed back by a stop. */
  released: number;
  /** Runs whose claim was superseded (reprocess / cancel / reclaim) — nothing written. */
  superseded: number;
}

/** The worker loop: claim → process until nothing is claimable or a stop is requested. */
export async function drainImports<R>(
  proc: { claimNext(): Promise<R | null>; processClaimed(row: R, stop: WorkerStop): Promise<RunOutcome> },
  stop: WorkerStop,
): Promise<DrainResult> {
  const out: DrainResult = { finished: 0, released: 0, superseded: 0 };
  while (!stop.requested) {
    const row = await proc.claimNext();
    if (!row) break;
    // A row claimed while the signal arrived is still handed over: its run sees the stop and releases it at once.
    out[await proc.processClaimed(row, stop)]++;
  }
  return out;
}
