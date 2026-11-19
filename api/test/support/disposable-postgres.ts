/**
 * Disposable Postgres for DB-backed e2e suites (WALLET-REVERSAL-ENGINE-DESIGN.md §13 WP7).
 *
 * SAFETY (hard rule): this harness NEVER reads DATABASE_URL or any .env file. It only ever talks to a server the
 * operator explicitly points it at, and that server must be on THIS machine (localhost / 127.0.0.1 / ::1).
 *
 * Modes (first match wins):
 *  1. `WRE_PG_ADMIN_URL=postgresql://user:pw@localhost:5432/postgres` — a throw-away local server (e.g. a Docker
 *     container). The harness CREATEs a brand-new database `wre_e2e_<ts>_<rand>`, applies every migration in
 *     api/prisma/migrations in order, hands it out, and DROPs it at the end (WRE_PG_KEEP_DB=1 keeps it for debugging).
 *     True multi-connection Postgres → real row-lock contention. THIS is the mode that proves concurrency safety.
 *  2. `WRE_PG_EMBEDDED=pglite` — an in-memory PGlite (Postgres compiled to WASM, already in node_modules via
 *     @prisma/dev) in a child process (pglite-server.cjs) behind a 127.0.0.1 socket; it dies with the run.
 *     PGlite is SINGLE-SESSION: the pool is forced to 1 connection, so every
 *     transaction is serialised. Good for validating the suite (schema, constraints, seeding, oracle replays);
 *     it is NOT evidence of concurrency safety — scenarios that need true overlap mark themselves accordingly.
 *  Neither set → `available()` is false and the suites skip.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);

export type DisposableMode = 'server' | 'pglite';

export function disposableMode(
  env: NodeJS.ProcessEnv = process.env,
): DisposableMode | null {
  if ((env.WRE_PG_ADMIN_URL ?? '').trim()) return 'server';
  if ((env.WRE_PG_EMBEDDED ?? '').trim().toLowerCase() === 'pglite')
    return 'pglite';
  return null;
}

/** Refuse anything that is not a local server; refuse database names that look like a real environment. */
export function assertLocalUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('WRE_PG_ADMIN_URL is not a valid postgres URL');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol))
    throw new Error('WRE_PG_ADMIN_URL must be a postgres:// URL');
  if (!LOCAL_HOSTS.has(u.hostname)) {
    throw new Error(
      `Refusing non-local Postgres host "${u.hostname}" — this harness only runs against a disposable local server`,
    );
  }
  if (u.searchParams.has('host'))
    throw new Error('Refusing a URL with a ?host= override');
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (/gifsy|prod|staging/i.test(db))
    throw new Error(`Refusing to connect to database "${db}"`);
  return u;
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name, 'migration.sql'))
    .filter((f) => fs.existsSync(f));
}

async function applyMigrations(client: Client): Promise<number> {
  const files = migrationFiles();
  for (const f of files) {
    const sql = fs.readFileSync(f, 'utf8');
    try {
      await client.query(sql);
    } catch (e) {
      throw new Error(
        `migration ${path.basename(path.dirname(f))} failed: ${(e as Error).message}`,
      );
    }
  }
  return files.length;
}

export interface DisposableDb {
  mode: DisposableMode;
  /** true only when the server can run transactions in parallel (mode 'server') */
  concurrent: boolean;
  url: string;
  databaseName: string;
  migrationsApplied: number;
  /**
   * A Prisma client bound to THIS database only (own pg pool; DATABASE_URL is never consulted).
   * `poolSize` / `txTimeoutMs` override the defaults (e.g. to mirror production: pg Pool max 10, Prisma tx 5 s).
   */
  prisma(opts?: { poolSize?: number; txTimeoutMs?: number }): PrismaClient;
  /** A raw pg client for lock-observation queries (pg_stat_activity). */
  rawClient(): Promise<Client>;
  dispose(): Promise<void>;
}

export async function startDisposableDb(
  opts: { poolSize?: number } = {},
): Promise<DisposableDb> {
  const mode = disposableMode();
  if (!mode)
    throw new Error(
      'No disposable Postgres configured (set WRE_PG_ADMIN_URL or WRE_PG_EMBEDDED=pglite)',
    );
  return mode === 'server'
    ? startServerDb(opts.poolSize ?? 12)
    : startPgliteDb();
}

const prismaOptions = {
  // Long waits on purpose: concurrency scenarios queue many transactions behind one wallet lock.
  transactionOptions: { maxWait: 60_000, timeout: 60_000 },
  log: [{ emit: 'stdout' as const, level: 'error' as const }],
};

async function startServerDb(poolSize: number): Promise<DisposableDb> {
  const admin = assertLocalUrl(process.env.WRE_PG_ADMIN_URL!.trim());
  const databaseName = `wre_e2e_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);
  await adminClient.end();

  const dbUrl = new URL(admin.toString());
  dbUrl.pathname = `/${databaseName}`;
  const url = dbUrl.toString();

  const migClient = new Client({ connectionString: url });
  await migClient.connect();
  const [{ db }] = (await migClient.query('SELECT current_database() AS db'))
    .rows as Array<{ db: string }>;
  if (db !== databaseName)
    throw new Error(`Connected to ${db}, expected ${databaseName}`);
  const migrationsApplied = await applyMigrations(migClient);
  await migClient.end();

  const clients: PrismaClient[] = [];
  const pools: Pool[] = [];
  const raws: Client[] = [];
  return {
    mode: 'server',
    concurrent: true,
    url,
    databaseName,
    migrationsApplied,
    prisma(o = {}) {
      const pool = new Pool({
        connectionString: url,
        max: o.poolSize ?? poolSize,
      });
      pool.on('error', () => undefined); // an idle client dropped at teardown must not crash the run
      pools.push(pool);
      const c = new PrismaClient({
        adapter: new PrismaPg(pool),
        ...prismaOptions,
        ...(o.txTimeoutMs
          ? {
              transactionOptions: {
                maxWait: o.txTimeoutMs,
                timeout: o.txTimeoutMs,
              },
            }
          : {}),
      });
      clients.push(c);
      return c;
    },
    async rawClient() {
      const c = new Client({ connectionString: url });
      await c.connect();
      raws.push(c);
      return c;
    },
    async dispose() {
      for (const c of clients) await c.$disconnect().catch(() => undefined);
      for (const p of pools) await p.end().catch(() => undefined);
      for (const c of raws) await c.end().catch(() => undefined);
      if (process.env.WRE_PG_KEEP_DB === '1') return;
      const drop = new Client({ connectionString: admin.toString() });
      await drop.connect();
      await drop.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await drop.end();
    },
  };
}

async function startPgliteDb(): Promise<DisposableDb> {
  // PGlite needs native dynamic import, which the jest VM does not provide → run it as a child process.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(__dirname, 'pglite-server.cjs'), String(port)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.resolve(__dirname, '..', '..'),
    },
  );
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(
      () => reject(new Error(`PGlite did not start: ${out}`)),
      60_000,
    );
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.includes(`READY ${port}`)) {
        clearTimeout(timer);
        resolve();
      } else if (out.includes('PGLITE_FAILED')) {
        clearTimeout(timer);
        reject(new Error(out));
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`PGlite exited ${code}: ${out}`));
    });
  });
  const killChild = () => {
    if (child.exitCode === null) child.kill();
  };
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

  let files: string[] = [];
  const mig = new Client({ connectionString: url });
  try {
    await mig.connect();
    files = migrationFiles();
    await applyMigrations(mig);
  } catch (e) {
    killChild();
    throw e;
  } finally {
    await mig.end().catch(() => undefined);
  }

  const clients: PrismaClient[] = [];
  const pools: Pool[] = [];
  const raws: Client[] = [];
  return {
    mode: 'pglite',
    concurrent: false,
    url,
    databaseName: 'pglite',
    migrationsApplied: files.length,
    prisma() {
      // (pool / timeout overrides are ignored: PGlite always runs one connection)
      // ONE connection: PGlite is single-session, so a second socket would interleave inside another transaction.
      // maxUses 1: a fresh socket per checkout. pglite-socket can leave a stale response on the wire after an error
      // inside a transaction (observed: the next query on that socket read the previous INSERT's row) — never reuse it.
      const pool = new Pool({ connectionString: url, max: 1, maxUses: 1 });
      pool.on('error', () => undefined); // an idle client dropped at teardown must not crash the run
      pools.push(pool);
      const c = new PrismaClient({
        adapter: new PrismaPg(pool),
        ...prismaOptions,
      });
      clients.push(c);
      return c;
    },
    rawClient() {
      return Promise.reject(
        new Error('rawClient() is not available on PGlite (single session)'),
      );
    },
    async dispose() {
      for (const c of clients) await c.$disconnect().catch(() => undefined);
      for (const p of pools) await p.end().catch(() => undefined);
      for (const c of raws) await c.end().catch(() => undefined);
      killChild();
    },
  };
}
