// GUARD (orders search audit #1): orderSearchWhere LIKE-escapes the term (escapeLikeLiteral). That is only
// right if Prisma's `contains` / `endsWith` on PostgreSQL binds our value VERBATIM inside the LIKE pattern
// (adding only its own `%` wildcards). This runs the REAL installed Prisma query compiler OFFLINE through a
// stub driver adapter (no database) — same technique as applies-to.prisma.compiled.spec.ts — and pins it.
// Run: npx jest --no-coverage src/rewards/order-search.compiled.spec.ts

import { PrismaClient } from '@prisma/client';
import { orderSearchWhere } from './rewards.service';

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

describe('orderSearchWhere — compiled SQL shape (offline, real Prisma query compiler)', () => {
  it('contains / endsWith compile to (I)LIKE with our ESCAPED term inside the pattern (no extra escaping by Prisma)', async () => {
    const captured: Captured[] = [];
    const prisma = new PrismaClient({ adapter: stubAdapterFactory(captured) as never });
    try {
      await prisma.redemptionOrder.findMany({ where: orderSearchWhere('50%_off', true)!, select: { id: true } });
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
    const q = captured.find((c) => /redemption_orders/i.test(c.sql));
    expect(q).toBeDefined();
    // contains → ILIKE ('%' || $n || '%'), endsWith → ILIKE ('%' || $n): Prisma adds only its own wildcards
    // around the bound value; our escaped term is bound VERBATIM (Postgres' default LIKE escape is `\`).
    expect(q!.sql).toMatch(/"orderNumber" ILIKE \('%' \|\| \$\d+ \|\| '%'\)/);
    expect(q!.sql).toMatch(/"id" ILIKE \('%' \|\| \$\d+\)/);
    expect(q!.sql).not.toMatch(/LOWER\(/i);
    expect(q!.sql).not.toMatch(/ESCAPE/i);
    const args = q!.args.map(String);
    expect(args).toEqual(expect.arrayContaining(['50\\%\\_off']));
    // Never the raw (wildcard-acting) term.
    expect(args).not.toContain('50%_off');
  });
});
