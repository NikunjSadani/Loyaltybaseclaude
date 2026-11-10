import { decideWorkerHeap, ensureWorkerHeap, WORKER_HEAP_FLOOR_MB, WORKER_HEAP_MB, WORKER_HEAP_REEXEC_ENV } from './worker-heap';

const MiB = 1024 * 1024;

describe('worker heap enforcement (audit M1)', () => {
  it('a heap at / above the floor runs as is', () => {
    expect(decideWorkerHeap(WORKER_HEAP_FLOOR_MB * MiB, {}, [])).toEqual({ kind: 'ok' });
    expect(decideWorkerHeap(1750 * MiB, {}, [])).toEqual({ kind: 'ok' });
  });

  it('below the floor → re-exec ONCE with --max-old-space-size=1700 (replacing any smaller flag), marked in env', () => {
    const d = decideWorkerHeap(1536 * MiB, {}, ['--enable-source-maps', '--max-old-space-size=1536']);
    expect(d).toEqual({
      kind: 'reexec',
      execArgv: ['--enable-source-maps', `--max-old-space-size=${WORKER_HEAP_MB}`],
      env: { [WORKER_HEAP_REEXEC_ENV]: '1' },
    });
  });

  it('still below the floor in the re-executed child → fail fast with a clear message (never loops)', () => {
    const d = decideWorkerHeap(1024 * MiB, { [WORKER_HEAP_REEXEC_ENV]: '1' }, [`--max-old-space-size=${WORKER_HEAP_MB}`]);
    expect(d.kind).toBe('fail');
    expect((d as { message: string }).message).toMatch(/1024 MB even after re-exec/);
  });
});

describe('ensureWorkerHeap (audit L-1 / L-2)', () => {
  const deps = (heapLimit: number, env: Record<string, string> = {}) => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const d = {
      heapLimit, env, execArgv: [], argv: ['node', 'dist/sales-import/worker.main.js'], execPath: '/usr/bin/node',
      spawn: jest.fn(() => ({ on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[ev] = cb) })),
      exit: jest.fn(), log: jest.fn(), error: jest.fn(),
    };
    return { d, handlers };
  };

  it('ok → runs in-process, nothing spawned', () => {
    const { d } = deps(1892 * MiB);
    expect(ensureWorkerHeap(d as never)).toBe(true);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('re-exec → child spawned with the flag + marker; the parent mirrors its exit code; a spawn error logs JSON + exits 1', () => {
    const { d, handlers } = deps(1024 * MiB);
    expect(ensureWorkerHeap(d as never)).toBe(false);
    expect(d.spawn).toHaveBeenCalledWith('/usr/bin/node', [`--max-old-space-size=${WORKER_HEAP_MB}`, 'dist/sales-import/worker.main.js'], {
      stdio: 'inherit', env: expect.objectContaining({ [WORKER_HEAP_REEXEC_ENV]: '1' }),
    });
    handlers.exit(3, null);
    expect(d.exit).toHaveBeenLastCalledWith(3);
    handlers.error(new Error('ENOENT'));
    expect(JSON.parse(d.error.mock.calls[0][0])).toEqual({ msg: 'sales-import worker: re-exec failed', error: 'ENOENT' });
    expect(d.exit).toHaveBeenLastCalledWith(1);
  });

  it('fail → JSON error + exit 1', () => {
    const { d } = deps(1024 * MiB, { [WORKER_HEAP_REEXEC_ENV]: '1' });
    expect(ensureWorkerHeap(d as never)).toBe(false);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('worker.main.ts loads Nest / Prisma / ExcelJS only AFTER the heap decision (dynamic imports)', () => {
    const src = jest.requireActual('fs').readFileSync(jest.requireActual('path').join(__dirname, '..', 'worker.main.ts'), 'utf8') as string;
    const staticImports = src.split('\n').filter((l) => /^import /.test(l));
    expect(staticImports.every((l) => /node:|worker-heap/.test(l))).toBe(true);
    expect(src).toContain("await import('@nestjs/core')");
  });
});
