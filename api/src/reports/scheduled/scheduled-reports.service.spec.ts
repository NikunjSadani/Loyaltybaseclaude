import { ScheduledReportsService } from './scheduled-reports.service';
import { loadHolidaySet } from '../../common/holiday-calendar';

jest.mock('../../common/holiday-calendar', () => ({ loadHolidaySet: jest.fn().mockResolvedValue(new Set<string>()) }));

const IST = 330 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 9, 30) - IST; // Fri 13 Nov 2026, 09:30 IST — fixed, never real now
const zeroAgg = { _count: { _all: 0 }, _sum: { totalPoints: null, totalPayoutPaise: null, amountPaise: null } };

/** A Prisma double where every query a quiet tenant needs resolves to "nothing". */
function makePrisma() {
  return {
    client: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'bajaj', internalName: 'bajaj', branding: { displayName: 'Bajaj' }, features: { hubbleVoucherEnabled: true, salesImport: true } },
        { id: 'deoleo', internalName: 'Deoleo', branding: {}, features: {} },
      ]),
    },
    programSetting: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockImplementation(({ where }: { where: { settingKey: unknown } }) =>
        Promise.resolve(where.settingKey === 'visibilityEnabled' ? [{ clientId: 'bajaj', settingValue: true }] : []),
      ),
    },
    kycSubmission: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    kycStatusHistory: { count: jest.fn().mockResolvedValue(0) },
    pointsLedger: { groupBy: jest.fn().mockResolvedValue([]) },
    wallet: { count: jest.fn().mockResolvedValue(0) },
    redemptionOrder: { count: jest.fn().mockResolvedValue(0) },
    redemptionStatusHistory: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    creditBatch: { aggregate: jest.fn().mockResolvedValue(zeroAgg) },
    creditPayoutEntry: { aggregate: jest.fn().mockResolvedValue(zeroAgg), count: jest.fn().mockResolvedValue(0) },
    payoutTransaction: { aggregate: jest.fn().mockResolvedValue(zeroAgg), count: jest.fn().mockResolvedValue(0) },
    messageDeliveryReceipt: { groupBy: jest.fn().mockResolvedValue([]) },
    otpCode: { count: jest.fn().mockResolvedValue(0) },
    whatsappBroadcastRecipient: { count: jest.fn().mockResolvedValue(0) },
    visibilityCapture: { count: jest.fn().mockResolvedValue(0) },
    visibilityCaptureSubmission: { count: jest.fn().mockResolvedValue(0) },
    salesImport: { count: jest.fn().mockResolvedValue(0) },
    salesMonthStatus: { findMany: jest.fn().mockResolvedValue([]) },
    salesKpiDefinition: { count: jest.fn().mockResolvedValue(0) },
    outletTarget: { groupBy: jest.fn().mockResolvedValue([]) },
  };
}

describe('ScheduledReportsService — Daily Operations Digest', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let sendEmail: jest.Mock;
  let svc: ScheduledReportsService;

  beforeEach(() => {
    jest.clearAllMocks();
    (loadHolidaySet as jest.Mock).mockResolvedValue(new Set<string>());
    prisma = makePrisma();
    sendEmail = jest.fn().mockResolvedValue(undefined);
    svc = new ScheduledReportsService(prisma as never, { sendEmail } as never);
  });

  it('legacy fallback: no dailyDigest key → ONE email to the union of creditsPayouts + kycActionables', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({
      settingValue: { creditsPayouts: ['Finance@gifsy.in', 'ops@gifsy.in'], kycActionables: ['ops@gifsy.in', 'kyc@gifsy.in'] },
    });
    const out = await svc.runDailyReports(NOW);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toEqual(['finance@gifsy.in', 'ops@gifsy.in', 'kyc@gifsy.in']);
    expect(sendEmail.mock.calls[0][0].subject).toBe('Gifsy daily operations — 13 Nov 2026 — 0 need attention');
    expect(out).toEqual({
      dateLabel: '13 Nov 2026',
      reports: [{ key: 'dailyDigest', status: 'sent', recipients: 3, tenants: 2, tenantsNeedingAttention: 0 }],
    });
  });

  it('a saved dailyDigest list wins over the legacy lists', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({
      settingValue: { dailyDigest: ['digest@gifsy.in'], creditsPayouts: ['old@gifsy.in'] },
    });
    await svc.runDailyReports(NOW);
    expect(sendEmail.mock.calls[0][0].to).toEqual(['digest@gifsy.in']);
  });

  it('no recipients → nothing sent, no data queried', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({ settingValue: { dailyDigest: [] } });
    const out = await svc.runDailyReports(NOW);
    expect(out.reports[0].status).toBe('no-recipients');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.client.findMany).not.toHaveBeenCalled();
  });

  it('all quiet → still sends ("All quiet")', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({ settingValue: { dailyDigest: ['ops@gifsy.in'] } });
    await svc.runDailyReports(NOW);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].html).toContain('All quiet — no tenant needs attention.');
  });

  it('section failure is isolated: that tenant shows "couldn\'t load", everything else renders and sends', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({ settingValue: { dailyDigest: ['ops@gifsy.in'] } });
    // pointsLedger blows up for Deoleo only.
    prisma.pointsLedger.groupBy.mockImplementation((args: { where: { wallet: { partner: { clientId: string } } } }) =>
      args.where.wallet.partner.clientId === 'deoleo' ? Promise.reject(new Error('db timeout')) : Promise.resolve([]),
    );
    const input = await svc.collect(NOW, '13 Nov 2026');
    const deoleo = input.tenants.find((t) => t.clientId === 'deoleo')!;
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    expect(deoleo.points).toEqual({ ok: false, error: 'db timeout' });
    expect(deoleo.kyc.ok).toBe(true);
    expect(bajaj.points.ok).toBe(true);

    const out = await svc.runDailyReports(NOW);
    expect(out.reports[0].status).toBe('sent');
    expect(out.reports[0].tenantsNeedingAttention).toBe(1);
    expect(sendEmail.mock.calls[0][0].html).toContain("Couldn't load this section (db timeout).");
  });

  it('gates the optional sections per tenant and windows queries on [now-24h, now)', async () => {
    const input = await svc.collect(NOW, '13 Nov 2026');
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    const deoleo = input.tenants.find((t) => t.clientId === 'deoleo')!;
    expect(bajaj.vouchers).toBeDefined();
    expect(bajaj.salesImport).toBeDefined();
    expect(bajaj.visibility).toBeDefined();
    expect(deoleo.vouchers).toBeUndefined();
    expect(deoleo.salesImport).toBeUndefined();
    expect(deoleo.visibility).toBeUndefined();
    // The Gifsy operator row is excluded from the tenant list.
    expect(prisma.client.findMany.mock.calls[0][0].where).toEqual({ status: 'ACTIVE', id: { not: 'gifsy' } });
    // Window: Friday → last 24 h.
    const where = prisma.redemptionOrder.count.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ gte: new Date(NOW - 24 * 3600 * 1000), lt: new Date(NOW) });
  });

  it('maps loaded rows into the sections (payout money, message channels, sales months)', async () => {
    prisma.creditPayoutEntry.aggregate.mockImplementation(({ where }: { where: { status: string } }) =>
      Promise.resolve(
        where.status === 'PROCESSING'
          ? { _count: { _all: 4 }, _sum: { amountPaise: 80000n } }
          : { _count: { _all: 2 }, _sum: { amountPaise: 150000n } },
      ),
    );
    prisma.messageDeliveryReceipt.groupBy.mockResolvedValue([{ channel: 'WHATSAPP', _count: { _all: 3 } }]);
    prisma.salesKpiDefinition.count.mockResolvedValue(1);
    prisma.salesMonthStatus.findMany.mockResolvedValue([
      { month: '2026-10', state: 'OPEN', closedAt: null, reopenedAt: null, lastAppliedAt: new Date(NOW - 5 * 86400000) },
    ]);
    prisma.outletTarget.groupBy.mockResolvedValue([{ month: '2026-10', _max: { updatedAt: new Date(NOW - 86400000) } }]);

    const input = await svc.collect(NOW, '13 Nov 2026');
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    expect(bajaj.payouts.ok && bajaj.payouts.data).toMatchObject({ creditPaid: 2, creditPaidPaise: 150000n, awaitingUtr: 4, awaitingUtrPaise: 80000n });
    expect(bajaj.messages.ok && bajaj.messages.data).toEqual({ otpFailed: 0, smsFailed: 0, whatsappFailed: 3, broadcastFailed: 0 });
    expect(bajaj.salesImport!.ok && bajaj.salesImport!.data.openMonths).toEqual([
      { month: '2026-11', lastAppliedAtMs: null, targetsChangedSinceApply: false },
      { month: '2026-10', lastAppliedAtMs: NOW - 5 * 86400000, targetsChangedSinceApply: true },
    ]);
  });

  it('a send failure is reported as error, not thrown', async () => {
    prisma.programSetting.findFirst.mockResolvedValue({ settingValue: { dailyDigest: ['ops@gifsy.in'] } });
    sendEmail.mockRejectedValue(new Error('smtp down'));
    const out = await svc.runDailyReports(NOW);
    expect(out.reports[0]).toEqual({ key: 'dailyDigest', status: 'error', error: 'smtp down' });
  });
});
