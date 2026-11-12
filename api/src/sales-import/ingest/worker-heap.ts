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

export interface WorkerHeapDeps {
  heapLimit: number;
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  argv: readonly string[];
  execPath: string;
  spawn: (cmd: string, args: string[], opts: { stdio: 'inherit'; env: NodeJS.ProcessEnv }) => {
    on(ev: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    on(ev: 'error', cb: (err: Error) => void): unknown;
    kill(signal: NodeJS.Signals): unknown;
  };
  exit: (code: number) => void;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Registers a process signal handler (re-exec parent: forwards SIGTERM / SIGINT to the child — plan §10c). */
  onSignal: (signal: 'SIGTERM' | 'SIGINT', cb: () => void) => void;
}

/**
 * Apply the decision. Returns true when THIS process should run the worker. Re-exec: spawns the child with the flag,
 * forwards SIGTERM / SIGINT to it, and mirrors its exit code; a spawn error (L-2) is logged as structured JSON and exits
 * 1. Imports only Node built-ins, so
 * the re-executing parent never loads Nest / Prisma / ExcelJS (L-1: worker.main.ts imports those only after this).
 */
export function ensureWorkerHeap(deps: WorkerHeapDeps): boolean {
  const d = decideWorkerHeap(deps.heapLimit, deps.env, deps.execArgv);
  if (d.kind === 'ok') return true;
  if (d.kind === 'fail') {
    deps.error(JSON.stringify({ msg: d.message }));
    deps.exit(1);
    return false;
  }
  deps.log(JSON.stringify({ msg: 'sales-import worker: heap below the floor; re-executing with the configured heap', execArgv: d.execArgv }));
  const child = deps.spawn(deps.execPath, [...d.execArgv, ...deps.argv.slice(1)], { stdio: 'inherit', env: { ...deps.env, ...d.env } });
  child.on('exit', (code, signal) => deps.exit(code ?? (signal ? 1 : 0)));
  // Cloud Run signals PID 1 (this parent). Forward it so the child stops gracefully (releases its claim); the parent
  // keeps running until the child exits and then mirrors its exit code (a handler suppresses the default termination).
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    deps.onSignal(sig, () => {
      deps.log(JSON.stringify({ msg: 'sales-import worker: forwarding signal to the re-executed child', signal: sig }));
      child.kill(sig);
    });
  }
  child.on('error', (err) => {
    deps.error(JSON.stringify({ msg: 'sales-import worker: re-exec failed', error: err?.message ?? String(err) }));
    deps.exit(1);
  });
  return false;
}
