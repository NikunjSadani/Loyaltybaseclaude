/**
 * Test-only: the REAL PrismaClient on a real (PGlite) Postgres — see api/test/pglite-socket-harness.cjs. The schema is
 * created from prisma/schema.prisma (`prisma migrate diff --from-empty`), plus any extra migration SQL a spec passes
 * (e.g. partial indexes Prisma cannot express). File name ends in `-spec.ts`: excluded from `nest build`, not a suite.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const API_ROOT = join(__dirname, '..', '..', '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

let cachedDdl: string | null = null;
/** Full DDL of the current Prisma schema (generated once per process). */
export function schemaDdl(): string {
  if (cachedDdl) return cachedDdl;
  const out = join(mkdtempSync(join(tmpdir(), 'pgl-ddl-')), 'schema.sql');
  const bin = join(API_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [bin, 'migrate', 'diff', '--config', join(API_ROOT, 'prisma.config.ts'), '--from-empty', '--to-schema', join(API_ROOT, 'prisma', 'schema.prisma'), '--script', '-o', out], {
    cwd: API_ROOT,
    stdio: 'ignore',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://x@localhost:5432/x' },
  });
  cachedDdl = readFileSync(out, 'utf8');
  return cachedDdl;
}

export function migrationSql(name: string): string {
  return readFileSync(join(API_ROOT, 'prisma', 'migrations', name, 'migration.sql'), 'utf8');
}

export interface PglitePrisma {
  prisma: PrismaClient;
  pool: Pool;
  close(): Promise<void>;
}

export async function startPglitePrisma(extraSql: string[] = []): Promise<PglitePrisma> {
  const child: ChildProcess = fork(join(API_ROOT, 'test', 'pglite-socket-harness.cjs'), [], { serialization: 'advanced' });
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    child.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    child.send({ op: 'start', port });
  });
  // maxUses: 1 — a FRESH socket per checkout. pglite-socket 0.1.x desynchronises a connection's replies after an
  // ErrorResponse inside a transaction (the next query gets the previous reply); a new connection per checkout keeps
  // every transaction exact (PGlite itself is one backend, so the database state is shared and correct).
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', password: 'postgres', max: 1, maxUses: 1 });
  await pool.query(schemaDdl());
  for (const s of extraSql) await pool.query(s);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    prisma,
    pool,
    close: async () => {
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await new Promise<void>((resolve) => {
        if (!child.connected) return resolve();
        child.once('message', () => resolve());
        child.send({ op: 'stop' });
        setTimeout(() => { child.kill(); resolve(); }, 5000);
      });
    },
  };
}
