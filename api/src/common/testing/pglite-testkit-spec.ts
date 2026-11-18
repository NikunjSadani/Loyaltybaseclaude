/**
 * Test-only: a real Postgres (PGlite, WASM) in a forked child process — see api/test/pglite-harness.cjs for why it
 * is forked. Used by specs that must prove SQL semantics (Usage Report: the atomic activity upsert and the per-user
 * aggregate). File name ends in `-spec.ts`: excluded from `nest build`, not itself a Jest suite.
 *
 * PGlite is ONE connection: statements run strictly in the order they are sent (true parallel connections — row
 * locks between two sessions — are standard Postgres ON CONFLICT behaviour and are not simulated here).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface PgliteTestDb {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function startPgliteTestDb(): PgliteTestDb {
  const child: ChildProcess = fork(join(__dirname, '..', '..', '..', 'test', 'pglite-harness.cjs'), [], {
    serialization: 'advanced',
  });
  let nextId = 0;
  const pending = new Map<number, (m: { ok: boolean; rows?: unknown[]; error?: string }) => void>();
  child.on('message', (m: { id: number; ok: boolean; rows?: unknown[]; error?: string }) => {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const call = (msg: Record<string, unknown>) =>
    new Promise<unknown[]>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.ok ? resolve(m.rows ?? []) : reject(new Error(m.error))));
      child.send({ ...msg, id });
    });
  return {
    exec: async (sql) => {
      await call({ op: 'exec', sql });
    },
    query: async <T>(sql: string, params: unknown[] = []) => (await call({ op: 'query', sql, params })) as T[],
    close: async () => {
      if (!child.connected) return;
      await call({ op: 'close' }).catch(() => child.kill());
    },
  };
}
