import { decideWorkerHeap, WORKER_HEAP_FLOOR_MB, WORKER_HEAP_MB, WORKER_HEAP_REEXEC_ENV } from './worker-heap';

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
