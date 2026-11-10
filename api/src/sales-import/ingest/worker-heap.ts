/**
 * The worker's V8 heap size is ENFORCED, not just documented (audit M1). The memory budget (plan §7.1 step 11) and the
 * heap backstop (75 % of heap_size_limit) assume `--max-old-space-size=1700` on the 2 GiB job. If the process starts
 * with a smaller heap (job deployed without the flag / NODE_OPTIONS), it re-executes itself once with the flag; if the
 * heap is STILL below the floor after that, it fails fast with a clear log instead of processing with a heap the budget
 * was not sized for.
 */
export const WORKER_HEAP_MB = 1700;
export const WORKER_HEAP_FLOOR_MB = 1600;
/** Set on the re-executed child so it never re-executes again. */
export const WORKER_HEAP_REEXEC_ENV = 'SALES_IMPORT_WORKER_HEAP_REEXEC';

const MiB = 1024 * 1024;

export type WorkerHeapDecision =
  | { kind: 'ok' }
  | { kind: 'reexec'; execArgv: string[]; env: Record<string, string> }
  | { kind: 'fail'; message: string };

export function decideWorkerHeap(heapLimitBytes: number, env: NodeJS.ProcessEnv, execArgv: readonly string[]): WorkerHeapDecision {
  const mb = Math.round(heapLimitBytes / MiB);
  if (heapLimitBytes >= WORKER_HEAP_FLOOR_MB * MiB) return { kind: 'ok' };
  if (env[WORKER_HEAP_REEXEC_ENV] === '1') {
    return {
      kind: 'fail',
      message: `sales-import worker: V8 heap limit is ${mb} MB even after re-exec with --max-old-space-size=${WORKER_HEAP_MB} (floor ${WORKER_HEAP_FLOOR_MB} MB). Check the job's memory (2 GiB) and NODE_OPTIONS.`,
    };
  }
  return {
    kind: 'reexec',
    // A command-line flag wins over NODE_OPTIONS; any earlier --max-old-space-size in execArgv is replaced.
    execArgv: [...execArgv.filter((a) => !a.startsWith('--max-old-space-size')), `--max-old-space-size=${WORKER_HEAP_MB}`],
    env: { [WORKER_HEAP_REEXEC_ENV]: '1' },
  };
}
