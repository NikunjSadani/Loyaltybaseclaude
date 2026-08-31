import { PayoutsService } from './payouts.service';
import { ListTransactionsQueryDto } from './dto/payouts.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * FIX 1 — payout-transactions list date filter must interpret a date-only bound as a FULL
 * INCLUSIVE IST day (via istDayRangeFilter), not a raw `new Date("YYYY-MM-DD")` (= 05:30 IST),
 * which would truncate the last IST day. Money math/scoping is untouched — this is a window fix.
 */
describe('PayoutsService.listTransactions — IST date-range filter (FIX 1)', () => {
  const user = { clientId: 'client-1' } as JwtPayload;

  function makeService() {
    let captured: any;
    const prisma = {
      payoutTransaction: {
        findMany: jest.fn(async (args: any) => {
          captured = args.where;
          return [];
        }),
        count: jest.fn(async () => 0),
      },
    } as any;
    const service = new PayoutsService(prisma, {} as any, {} as any);
    return { service, prisma, getWhere: () => captured };
  }

  it('includes a 23:00-IST-today row when filtering with a date-only `dateTo = today` (IST bounds, not raw)', async () => {
    const { service, getWhere } = makeService();
    const q: ListTransactionsQueryDto = { dateTo: '2026-08-31' } as ListTransactionsQueryDto;

    await service.listTransactions(user, q);
    const where = getWhere();

    // A row created at 23:00 IST on 2026-08-31 = 2026-08-31T17:30:00.000Z.
    const rowAt2300Ist = new Date('2026-08-31T17:30:00.000Z');
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    // With the fix, lte = end of the IST day (2026-08-31T18:29:59.999Z) → the 23:00 IST row is INCLUDED.
    expect(rowAt2300Ist.getTime()).toBeLessThanOrEqual(where.createdAt.lte.getTime());
    // Regression guard: a raw `new Date("2026-08-31")` (05:30 IST = 00:00Z) would have EXCLUDED it.
    expect(where.createdAt.lte.getTime()).toBeGreaterThan(new Date('2026-08-31T00:00:00.000Z').getTime());
  });

  it('expands a date-only `dateFrom` to 00:00 IST (start of the IST day)', async () => {
    const { service, getWhere } = makeService();
    const q: ListTransactionsQueryDto = { dateFrom: '2026-08-01' } as ListTransactionsQueryDto;

    await service.listTransactions(user, q);
    const where = getWhere();

    // 00:00 IST on 2026-08-01 = 2026-07-31T18:30:00.000Z.
    expect(where.createdAt.gte.getTime()).toBe(new Date('2026-07-31T18:30:00.000Z').getTime());
  });

  it('leaves createdAt unset when no date bounds are supplied', async () => {
    const { service, getWhere } = makeService();
    await service.listTransactions(user, {} as ListTransactionsQueryDto);
    expect(getWhere().createdAt).toBeUndefined();
  });
});
