import { BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { redemptionScreenSummary } from './redemption-report.summary';

const CA = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const OWNER = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;

function prisma(over: Record<string, unknown> = {}) {
  return {
    redemptionOrder: {
      groupBy: jest.fn(async () => [
        { status: 'DELIVERED', _count: { _all: 2 }, _sum: { pointsDeducted: 900, totalPointsCost: 900 } },
        { status: 'CANCELLED', _count: { _all: 1 }, _sum: { pointsDeducted: 0, totalPointsCost: 400 } },
      ]),
      aggregate: jest.fn(async () => ({ _sum: { valuePaise: 90_000n } })),
      count: jest.fn(async () => 3),
    },
    outlet: { findMany: jest.fn(async () => [{ zone: 'West', state: 'Goa' }]) },
    client: { findUnique: jest.fn(async () => null) },
    salesHierarchyLevel: {
      findMany: jest.fn(async () => [
        { id: 'l1', code: 'XSR', name: 'ISR', level: 1 },
        { id: 'l3', code: 'ASM', name: 'ASM', level: 3 },
      ]),
    },
    ...over,
  };
}

describe('redemption screen summary', () => {
  it('totals points DEDUCTED and the value of orders that took points (same rule as the Excel)', async () => {
    const db = prisma();
    const s = await redemptionScreenSummary(db as never, CA, { from: '2025-11-01', to: '2025-11-30', clientId: 'deoleo' }, new Date());
    expect(s).toMatchObject({ clientId: 'bajaj', orders: 3, pointsDeducted: 900, pointsRequested: 1300, valueInr: 900, asmLevelLabel: 'ASM' });
    expect(db.redemptionOrder.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ pointsDeducted: { gt: 0 }, partner: { clientId: 'bajaj' } }) }),
    );
    expect(db.client.findUnique).not.toHaveBeenCalled(); // pinned users never look a client up
  });

  it('an un-assumed owner must name a KNOWN client', async () => {
    await expect(redemptionScreenSummary(prisma() as never, OWNER, {}, new Date())).rejects.toBeInstanceOf(BadRequestException);
    await expect(redemptionScreenSummary(prisma() as never, OWNER, { clientId: 'nope' }, new Date())).rejects.toThrow('Unknown client: nope');
  });
});
