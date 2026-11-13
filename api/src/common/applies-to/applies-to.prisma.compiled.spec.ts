// GUARD (audit #6): `escapeLikeLiteral` is only correct because Prisma compiles
// `{ equals: v, mode: 'insensitive' }` on PostgreSQL to `"col" ILIKE $n` with the value bound VERBATIM.
// If a Prisma upgrade ever compiled it differently (e.g. `LOWER(col) = LOWER($n)`), the escaped value
// `SSS\_TOT` would stop matching `SSS_TOT` and every scope filter would silently return nothing.
// This test runs the REAL installed Prisma query compiler fully OFFLINE through a stub driver adapter
// that only records the SQL + args (no database), and pins the compiled shape.
// Run: npx jest --no-coverage src/common/applies-to/applies-to.prisma.compiled.spec.ts

import { PrismaClient } from '@prisma/client';
import { appliesToOutletWhere } from './applies-to.prisma';

type Captured = { sql: string; args: unknown[] };

function stubAdapterFactory(captured: Captured[]) {
  const queryable = {
    provider: 'postgres' as const,
    adapterName: 'audit-stub',
    async queryRaw(q: { sql: string; args: unknown[] }) {
      captured.push({ sql: q.sql, args: q.args });
      return { columnNames: [], columnTypes: [], rows: [] };
    },
    async executeRaw(q: { sql: string; args: unknown[] }) {
      captured.push({ sql: q.sql, args: q.args });
      return 0;
    },
  };
  const adapter = {
    ...queryable,
    async executeScript() {},
    async startTransaction() {
      return {
        ...queryable,
        options: { usePhantomQuery: false },
        async commit() {},
        async rollback() {},
        async createSavepoint() {},
        async rollbackToSavepoint() {},
        async releaseSavepoint() {},
      };
    },
    async dispose() {},
  };
  return {
    provider: 'postgres' as const,
    adapterName: 'audit-stub',
    async connect() {
      return adapter;
    },
  };
}

describe('appliesToOutletWhere — compiled SQL shape (offline, real Prisma query compiler)', () => {
  it('insensitive equals compiles to ILIKE with the escaped value bound verbatim', async () => {
    const captured: Captured[] = [];
    const prisma = new PrismaClient({ adapter: stubAdapterFactory(captured) as never });
    try {
      await prisma.outlet.findMany({
        where: appliesToOutletWhere({ outletTypes: ['SSS_TOT'], programs: ['R_P%'], subPrograms: ['A\\B'] }),
        select: { id: true },
      });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
    const q = captured.find((c) => /FROM\s+"public"\."outlets"/i.test(c.sql));
    expect(q).toBeDefined();
    // programName / programCategory compared with ILIKE (not LOWER(...) = LOWER(...)).
    expect(q!.sql).toMatch(/"programName"\s+ILIKE\s+\$\d+/);
    expect(q!.sql).toMatch(/"programCategory"\s+ILIKE\s+\$\d+/);
    expect(q!.sql).toMatch(/"code"\s+ILIKE\s+\$\d+/);
    expect(q!.sql).not.toMatch(/LOWER\(/i);
    // Escaped literals reach the driver VERBATIM — Prisma adds no escaping of its own.
    const args = q!.args.map(String);
    expect(args).toEqual(expect.arrayContaining(['SSS\\_TOT', 'R\\_P\\%', 'A\\\\B']));
  });
});
