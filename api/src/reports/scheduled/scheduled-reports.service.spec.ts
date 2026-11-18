import { ScheduledReportsService } from './scheduled-reports.service';
import { loadHolidaySet } from '../../common/holiday-calendar';
import { loadBillingProgress } from '../../admin-core/dashboards/billing-progress';
import { digestWindow } from './daily-ops-digest-report';
import { HUBBLE_NO_ORDER_REFUND_REASON } from '../../rewards/rewards.service';

jest.mock('../../common/holiday-calendar', () => ({ loadHolidaySet: jest.fn().mockResolvedValue(new Set<string>()) }));
// The dashboard loader has its own spec; here only its wiring is checked (the real summarize maps it).
jest.mock('../../admin-core/dashboards/billing-progress', () => ({
  ...jest.requireActual('../../admin-core/dashboards/billing-progress'),
  loadBillingProgress: jest.fn(),
}));

/** A minimal BillingProgressData: 3 outlets with a target (2 not started), 1 without, 1 not covered. */
function billingData() {
  const row = (code: string, target: number, achieved: number, bucket: string | null) => ({
    outletCode: code, outletName: code, program: null, outletType: null, soName: null, asmName: null,
    target, achieved, pct: null, note: null, rawPct: 0, bucket, behindPace: false,
  });
  return {
    month: '2026-11', kpi: { code: 'TOTAL', label: 'Total Sales', unit: '' }, asOf: '2026-11-12',
    monthStatus: 'CURRENT', daysInMonth: 30, daysElapsed: 12, pacePct: 40, paceAsOf: '2026-11-12', fullMonth: false,
    inScope: [row('A', 100, 0, 'NOT_STARTED'), row('B', 100, 0, 'NOT_STARTED'), row('C', 100, 50, 'P40_60')],
    noTarget: [row('D', 0, 0, null)],
    notCovered: [row('E', 0, 0, null)],
    targetsOutsideRoster: 1,
    managerName: null, availablePrograms: [], availableOutletTypes: [], availableManagers: [],
  };
}

const IST = 330 * 60 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 13, 9, 30) - IST; // Fri 13 Nov 2026, 09:30 IST — fixed, never real now
const WIN = digestWindow(NOW);
const zeroAgg = { _count: { _all: 0 }, _sum: { totalPoints: null, totalPayoutPaise: null, totalOutlets: null, amountPaise: null } };

/** A Prisma double where every query a quiet tenant needs resolves to "nothing". */
function makePrisma() {
  return {
    client: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'bajaj', internalName: 'bajaj', status: 'ACTIVE', branding: { displayName: 'Bajaj' }, features: { hubbleVoucherEnabled: true, salesImport: true } },
        { id: 'deoleo', internalName: 'Deoleo', status: 'ACTIVE', branding: {}, features: {} },
      ]),
    },
    programSetting: {
      // recipients row
      findFirst: jest.fn().mockResolvedValue(null),
      // run-state row
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockImplementation(({ where }: { where: { settingKey: unknown } }) =>
        Promise.resolve(where.settingKey === 'visibilityEnabled' ? [{ clientId: 'bajaj', settingValue: true }] : []),
      ),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    outlet: { findMany: jest.fn().mockResolvedValue([]) },
    kycSubmission: { count: jest.fn().mockResolvedValue(0) },
    kycStatusHistory: { count: jest.fn().mockResolvedValue(0) },
    pointsLedger: { groupBy: jest.fn().mockResolvedValue([]) },
    wallet: { count: jest.fn().mockResolvedValue(0) },
    redemptionOrder: { count: jest.fn().mockResolvedValue(0) },
    redemptionStatusHistory: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    creditBatch: { aggregate: jest.fn().mockResolvedValue(zeroAgg) },
    creditPayoutEntry: { aggregate: jest.fn().mockResolvedValue(zeroAgg), count: jest.fn().mockResolvedValue(0) },
    payoutTransaction: {
      aggregate: jest.fn().mockResolvedValue(zeroAgg),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    messageDeliveryReceipt: { groupBy: jest.fn().mockResolvedValue([]) },
    otpCode: { count: jest.fn().mockResolvedValue(0) },
    whatsappBroadcastRecipient: { count: jest.fn().mockResolvedValue(0) },
    visibilityCapture: { count: jest.fn().mockResolvedValue(0) },
    visibilityCaptureSubmission: { count: jest.fn().mockResolvedValue(0) },
    salesImport: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null) },
    salesMonthStatus: { findMany: jest.fn().mockResolvedValue([]) },
    salesKpiDefinition: { count: jest.fn().mockResolvedValue(0) },
    outletTarget: { groupBy: jest.fn().mockResolvedValue([]) },
    voucherDispersalRow: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  };
}

const recipients = (list: string[]) => ({ settingValue: { dailyDigest: list } });
const stateRow = (value: unknown) => ({ id: 'rs', updatedAt: new Date(NOW - DAY), settingValue: value });
/** The settingValue written by the LAST upsert of the run-state row. */
const lastWritten = (prisma: ReturnType<typeof makePrisma>) => {
  const calls = prisma.programSetting.upsert.mock.calls;
  return calls[calls.length - 1][0].update.settingValue;
};

describe('ScheduledReportsService — Daily Operations Digest', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let sendEmail: jest.Mock;
  let svc: ScheduledReportsService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REPORTS_RECIPIENT_DOMAINS;
    (loadHolidaySet as jest.Mock).mockResolvedValue(new Set<string>());
    (loadBillingProgress as jest.Mock).mockResolvedValue(billingData());
    prisma = makePrisma();
    sendEmail = jest.fn().mockResolvedValue(undefined);
    svc = new ScheduledReportsService(prisma as never, { sendEmail } as never);
  });

  describe('recipients', () => {
    it('legacy fallback: no dailyDigest key → ONE email to the union of creditsPayouts + kycActionables', async () => {
      prisma.programSetting.findFirst.mockResolvedValue({
        settingValue: { creditsPayouts: ['Finance@gifsy.in', 'ops@gifsy.in'], kycActionables: ['ops@gifsy.in', 'kyc@gifsy.in'] },
      });
      const out = await svc.runDailyReports(NOW);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0].to).toEqual(['finance@gifsy.in', 'ops@gifsy.in', 'kyc@gifsy.in']);
      expect(sendEmail.mock.calls[0][0].subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — all quiet');
      expect(out.reports[0]).toMatchObject({ key: 'dailyDigest', status: 'sent', recipients: 3, tenants: 2, tenantsNeedingAttention: 0 });
    });

    it('a saved dailyDigest list wins over the legacy lists', async () => {
      prisma.programSetting.findFirst.mockResolvedValue({
        settingValue: { dailyDigest: ['digest@gifsy.in'], creditsPayouts: ['old@gifsy.in'] },
      });
      await svc.runDailyReports(NOW);
      expect(sendEmail.mock.calls[0][0].to).toEqual(['digest@gifsy.in']);
    });

    it('non-internal addresses are DROPPED at send time and named in the footer + the outcome', async () => {
      prisma.programSetting.findFirst.mockResolvedValue({ settingValue: { creditsPayouts: ['ops@gifsy.in', 'cfo@acme.com'] } });
      const out = await svc.runDailyReports(NOW);
      expect(sendEmail.mock.calls[0][0].to).toEqual(['ops@gifsy.in']);
      expect(sendEmail.mock.calls[0][0].html).toContain('Not sent to cfo@acme.com');
      expect(out.reports[0].droppedRecipients).toEqual(['cfo@acme.com']);
    });

    it('only non-internal addresses → no-recipients (nothing sent, dropped list reported)', async () => {
      prisma.programSetting.findFirst.mockResolvedValue(recipients(['cfo@acme.com']));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0]).toMatchObject({ status: 'no-recipients', droppedRecipients: ['cfo@acme.com'] });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('no recipients → nothing sent, no data queried, the attempt is recorded', async () => {
      prisma.programSetting.findFirst.mockResolvedValue(recipients([]));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('no-recipients');
      expect(sendEmail).not.toHaveBeenCalled();
      expect(prisma.client.findMany).not.toHaveBeenCalled();
      expect(lastWritten(prisma).lastAttempt).toMatchObject({ status: 'no-recipients' });
    });

    it('a recipient READ failure is an error — never mistaken for "no recipients"', async () => {
      prisma.programSetting.findFirst.mockRejectedValue(new Error('conn reset'));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('error');
      expect(out.reports[0].error).toContain('conn reset');
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('run state (H3): window since the last successful send + idempotency', () => {
    beforeEach(() => prisma.programSetting.findFirst.mockResolvedValue(recipients(['ops@gifsy.in'])));

    it('first run (no state): the fixed rule window; records lastSuccess with that window', async () => {
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].window).toEqual(WIN);
      expect(prisma.programSetting.create).toHaveBeenCalledTimes(1); // the lease
      const st = lastWritten(prisma);
      expect(st.running).toBeNull();
      expect(st.lastSuccess).toEqual({ windowStartMs: WIN.startMs, windowEndMs: NOW, sentAt: new Date(NOW).toISOString(), recipients: 1 });
      expect(st.lastAttempt).toMatchObject({ status: 'sent' });
    });

    it('next window starts at the last successful window end (here 30 h back)', async () => {
      const lastEnd = NOW - 30 * HOUR;
      prisma.programSetting.findUnique.mockResolvedValue(
        stateRow({ lastSuccess: { windowStartMs: lastEnd - DAY, windowEndMs: lastEnd, sentAt: new Date(lastEnd).toISOString(), recipients: 1 } }),
      );
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('sent');
      expect(out.reports[0].window!.startMs).toBe(lastEnd);
      const where = prisma.redemptionOrder.count.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({ gte: new Date(lastEnd), lt: new Date(NOW) });
      // Lease taken with optimistic concurrency on the row version.
      expect(prisma.programSetting.updateMany.mock.calls[0][0].where).toEqual({ id: 'rs', updatedAt: new Date(NOW - DAY) });
    });

    it('a successful send already today → skipped (200 path), nothing queried or sent', async () => {
      const sent = NOW - 2 * HOUR; // 07:30 IST today
      prisma.programSetting.findUnique.mockResolvedValue(
        stateRow({ lastSuccess: { windowStartMs: sent - DAY, windowEndMs: sent, sentAt: new Date(sent).toISOString(), recipients: 1 } }),
      );
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0]).toMatchObject({ status: 'skipped', skipped: 'already-sent', lastSentAt: new Date(sent).toISOString() });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(prisma.client.findMany).not.toHaveBeenCalled();
    });

    it('force=true re-runs today, re-covering today\'s window up to now', async () => {
      const sent = NOW - 2 * HOUR;
      prisma.programSetting.findUnique.mockResolvedValue(
        stateRow({ lastSuccess: { windowStartMs: sent - DAY, windowEndMs: sent, sentAt: new Date(sent).toISOString(), recipients: 1 } }),
      );
      const out = await svc.runDailyReports(NOW, { force: true });
      expect(out.reports[0].status).toBe('sent');
      expect(out.reports[0].window!.startMs).toBe(sent - DAY);
      expect(sendEmail.mock.calls[0][0].html).toContain('manual re-run');
      expect(lastWritten(prisma).lastSuccess).toMatchObject({ forced: true, windowEndMs: NOW });
    });

    it('window capped at 7 days, and the uncovered gap is a LOUD notice (attention + INCOMPLETE subject)', async () => {
      const lastEnd = NOW - 10 * DAY;
      prisma.programSetting.findUnique.mockResolvedValue(
        stateRow({ lastSuccess: { windowStartMs: lastEnd - DAY, windowEndMs: lastEnd, sentAt: new Date(lastEnd).toISOString(), recipients: 1 } }),
      );
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].window!.startMs).toBe(NOW - 7 * DAY);
      expect(out.reports[0].status).toBe('sent'); // a capped window is complete for what it covers
      expect(sendEmail.mock.calls[0][0].subject).toContain('INCOMPLETE');
      expect(sendEmail.mock.calls[0][0].html).toContain('is NOT in any digest');
    });

    it('another run holds a live lease → in-progress, nothing sent', async () => {
      prisma.programSetting.findUnique.mockResolvedValue(stateRow({ running: { startedAt: new Date(NOW - 60_000).toISOString(), token: 't' } }));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('in-progress');
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('a stale lease (> 15 min) is taken over', async () => {
      prisma.programSetting.findUnique.mockResolvedValue(stateRow({ running: { startedAt: new Date(NOW - 20 * 60_000).toISOString(), token: 't' } }));
      expect((await svc.runDailyReports(NOW)).reports[0].status).toBe('sent');
    });

    it('losing the optimistic lease race → in-progress', async () => {
      prisma.programSetting.findUnique.mockResolvedValue(stateRow({}));
      prisma.programSetting.updateMany.mockResolvedValue({ count: 0 });
      expect((await svc.runDailyReports(NOW)).reports[0].status).toBe('in-progress');
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('a send failure → error; lastSuccess untouched, lease cleared, attempt recorded', async () => {
      const lastEnd = NOW - DAY;
      const ls = { windowStartMs: lastEnd - DAY, windowEndMs: lastEnd, sentAt: new Date(lastEnd).toISOString(), recipients: 1 };
      prisma.programSetting.findUnique.mockResolvedValue(stateRow({ lastSuccess: ls }));
      sendEmail.mockRejectedValue(new Error('smtp down'));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0]).toMatchObject({ key: 'dailyDigest', status: 'error', error: 'smtp down' });
      const st = lastWritten(prisma);
      expect(st.lastSuccess).toEqual(ls);
      expect(st.running).toBeNull();
      expect(st.lastAttempt).toMatchObject({ status: 'error', error: 'smtp down' });
    });

    it('run-state READ failure: still sends on the fixed window, DEGRADED, and never writes the state back', async () => {
      prisma.programSetting.findUnique.mockRejectedValue(new Error('timeout'));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('degraded');
      expect(out.reports[0].window).toEqual(WIN);
      expect(sendEmail.mock.calls[0][0].html).toContain('Couldn&#39;t read the digest run history (timeout)');
      expect(prisma.programSetting.upsert).not.toHaveBeenCalled();
    });

    it('the email went out but the state write failed → reported as error (loud), not sent', async () => {
      prisma.programSetting.upsert.mockRejectedValue(new Error('write denied'));
      const out = await svc.runDailyReports(NOW);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(out.reports[0].status).toBe('error');
      expect(out.reports[0].error).toContain('WAS sent');
    });
  });

  describe('shared loaders (H2): a failure still sends, loudly, and degrades the run', () => {
    beforeEach(() => prisma.programSetting.findFirst.mockResolvedValue(recipients(['ops@gifsy.in'])));

    it('tenant list failure → email with the "incomplete" notice and Gifsy-wide figures; degraded; window not advanced', async () => {
      prisma.client.findMany.mockRejectedValue(new Error('pool exhausted'));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('degraded');
      const mail = sendEmail.mock.calls[0][0];
      expect(mail.subject).toContain('INCOMPLETE');
      expect(mail.html).toContain('Couldn&#39;t load the tenant list (pool exhausted)');
      const st = lastWritten(prisma);
      expect(st.lastSuccess).toBeUndefined();
      expect(st.lastAttempt).toMatchObject({ status: 'degraded' });
    });

    it('holiday calendar failure → weekends-only SLA + notice; degraded', async () => {
      (loadHolidaySet as jest.Mock).mockRejectedValue(new Error('bad json'));
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('degraded');
      expect(sendEmail.mock.calls[0][0].html).toContain('national holiday calendar (bad json)');
    });

    it('SLA targets failure → defaults + notice; degraded', async () => {
      prisma.programSetting.findMany.mockImplementation(({ where }: { where: { settingKey: unknown } }) =>
        where.settingKey === 'visibilityEnabled' ? Promise.resolve([]) : Promise.reject(new Error('nope')),
      );
      const out = await svc.runDailyReports(NOW);
      expect(out.reports[0].status).toBe('degraded');
      expect(sendEmail.mock.calls[0][0].html).toContain('per-tenant KYC SLA targets (nope)');
    });
  });

  it('section failure is isolated: that tenant shows "couldn\'t load", everything else renders and sends', async () => {
    prisma.programSetting.findFirst.mockResolvedValue(recipients(['ops@gifsy.in']));
    // pointsLedger blows up for Deoleo only.
    prisma.pointsLedger.groupBy.mockImplementation((args: { where: { wallet: { partner: { clientId: string } } } }) =>
      args.where.wallet.partner.clientId === 'deoleo' ? Promise.reject(new Error('db timeout')) : Promise.resolve([]),
    );
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
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

  it('loads every non-gifsy tenant incl. ONBOARDING/INACTIVE; vouchers for all; gates visibility / sales import', async () => {
    prisma.client.findMany.mockResolvedValue([
      { id: 'bajaj', internalName: 'bajaj', status: 'ACTIVE', branding: {}, features: { hubbleVoucherEnabled: true, salesImport: true } },
      { id: 'deoleo', internalName: 'Deoleo', status: 'ACTIVE', branding: {}, features: {} },
      { id: 'newco', internalName: 'NewCo', status: 'ONBOARDING', branding: {}, features: {} },
    ]);
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    expect(prisma.client.findMany.mock.calls[0][0].where).toEqual({ id: { not: 'gifsy' } });
    const by = (id: string) => input.tenants.find((t) => t.clientId === id)!;
    expect(by('newco').status).toBe('ONBOARDING');
    expect(by('deoleo').vouchers).toBeDefined(); // live Hubble problems show even with the flag off
    expect(by('deoleo').hubbleEnabled).toBe(false);
    expect(by('bajaj').hubbleEnabled).toBe(true);
    expect(by('bajaj').salesImport).toBeDefined();
    expect(by('deoleo').salesImport).toBeUndefined();
    expect(by('deoleo').visibility).toBeUndefined();
  });

  it('payouts (H1): credit payouts PAID/FAILED by the RECORDED time (updatedAt), never paidAt; outlets + still-open', async () => {
    prisma.creditBatch.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { totalPoints: 900, totalPayoutPaise: 90000n, totalOutlets: 37 } });
    prisma.creditPayoutEntry.aggregate.mockImplementation(({ where }: { where: { status: string; updatedAt?: unknown } }) =>
      Promise.resolve(
        where.status === 'PROCESSING'
          ? { _count: { _all: 4 }, _sum: { amountPaise: 80000n } }
          : where.status === 'FAILED'
            ? { _count: { _all: 3 }, _sum: { amountPaise: 30000n } }
            : { _count: { _all: 2 }, _sum: { amountPaise: 150000n } },
      ),
    );
    prisma.payoutTransaction.findMany.mockResolvedValue([{ redemptionOrderId: 'o1' }, { redemptionOrderId: 'o2' }, { redemptionOrderId: null }]);
    prisma.redemptionOrder.count.mockImplementation(({ where }: { where: { id?: unknown } }) => Promise.resolve(where.id ? 1 : 0));
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    const paidWhere = prisma.creditPayoutEntry.aggregate.mock.calls.find((c: [{ where: { status: string } }]) => c[0].where.status === 'PAID')[0].where;
    expect(paidWhere).toEqual({ clientId: 'bajaj', status: 'PAID', updatedAt: { gte: new Date(WIN.startMs), lt: new Date(NOW) } });
    expect(paidWhere.paidAt).toBeUndefined();
    expect(bajaj.payouts.ok && bajaj.payouts.data).toMatchObject({
      batchOutlets: 37,
      creditPaid: 2,
      creditPaidPaise: 150000n,
      awaitingUtr: 4,
      openFailedCredit: 3,
      openFailedCreditPaise: 30000n,
      openFailedRedemption: 2, // 3 failed txns, 1 whose order was failed/refunded
    });
  });

  it('messages + sales months mapped; Sales Import FAILED by finishedAt; failedOpen = FAILED after the last READY', async () => {
    prisma.messageDeliveryReceipt.groupBy.mockResolvedValue([{ channel: 'WHATSAPP', _count: { _all: 3 } }]);
    prisma.salesKpiDefinition.count.mockResolvedValue(1);
    prisma.salesMonthStatus.findMany.mockResolvedValue([
      { month: '2026-10', state: 'OPEN', closedAt: null, reopenedAt: null, lastAppliedAt: new Date(NOW - 5 * DAY) },
    ]);
    prisma.outletTarget.groupBy.mockResolvedValue([{ month: '2026-10', _max: { updatedAt: new Date(NOW - DAY) } }]);
    const lastReady = new Date(NOW - 3 * DAY);
    prisma.salesImport.findFirst.mockResolvedValue({ createdAt: lastReady });
    prisma.salesImport.count.mockImplementation(({ where }: { where: { status: string; createdAt?: unknown } }) =>
      Promise.resolve(where.status === 'FAILED' && where.createdAt ? 2 : 0),
    );

    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    expect(bajaj.messages.ok && bajaj.messages.data).toEqual({ otpFailed: 0, smsFailed: 0, whatsappFailed: 3, broadcastFailed: 0 });
    const s = bajaj.salesImport!.ok && bajaj.salesImport!.data;
    expect(s && s.failedOpen).toBe(2);
    expect(s && s.openMonths).toEqual([
      { month: '2026-11', lastAppliedAtMs: null, targetsChangedSinceApply: false },
      { month: '2026-10', lastAppliedAtMs: NOW - 5 * DAY, targetsChangedSinceApply: true },
    ]);
    const wheres = prisma.salesImport.count.mock.calls.map((c: [{ where: Record<string, unknown> }]) => c[0].where);
    const win = { gte: new Date(WIN.startMs), lt: new Date(NOW) };
    expect(wheres).toContainEqual({ clientId: 'bajaj', status: 'FAILED', finishedAt: win });
    expect(wheres).toContainEqual({ clientId: 'bajaj', status: 'FAILED', createdAt: { gt: lastReady } });
    expect(wheres.some((w: Record<string, unknown>) => 'updatedAt' in w)).toBe(false);
  });

  it('redemptions: still-open = FAILED orders still holding points', async () => {
    prisma.redemptionOrder.count.mockImplementation(({ where }: { where: { status?: string } }) =>
      Promise.resolve(where.status === 'FAILED' ? 1 : 0),
    );
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const r = input.tenants[0].redemptions;
    expect(r.ok && r.data.failedNotRefunded).toBe(1);
    const call = prisma.redemptionOrder.count.mock.calls.find((c: [{ where: { status?: string } }]) => c[0].where.status === 'FAILED')[0];
    expect(call.where).toEqual({ partner: { clientId: 'bajaj' }, status: 'FAILED', pointsDeducted: { gt: 0 } });
  });

  it('vouchers: Hubble failures include the unstamped no-order refund; stuck measured from the PROCESSING history row', async () => {
    await svc.collect(NOW, '13 Nov 2026', WIN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failedCall: any = prisma.redemptionStatusHistory.count.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0].where)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((w: any) => w.toStatus === 'FAILED' && w.order.OR);
    expect(failedCall.order.OR).toEqual([
      { voucherProvider: { equals: 'hubble', mode: 'insensitive' } },
      { cancelReason: HUBBLE_NO_ORDER_REFUND_REASON },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stuck: any = prisma.redemptionOrder.count.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0].where)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((w: any) => w.status === 'PROCESSING');
    const cutoff = new Date(NOW - 30 * 60_000);
    expect(stuck.statusHistory).toEqual({ none: { toStatus: 'PROCESSING', createdAt: { gte: cutoff } } });
    expect(stuck.OR).toEqual([
      { statusHistory: { some: { toStatus: 'PROCESSING', createdAt: { lt: cutoff } } } },
      { statusHistory: { none: { toStatus: 'PROCESSING' } }, updatedAt: { lt: cutoff } },
    ]);
    expect(stuck.updatedAt).toBeUndefined();
  });

  it('KYC: the dashboard population (addressable outlets → latest submission) and unrounded SLA', async () => {
    prisma.outlet.findMany.mockImplementation(({ where }: { where: { clientId: string } }) =>
      Promise.resolve(
        where.clientId === 'bajaj'
          ? [
              {
                partner: {
                  kycSubmissions: [
                    {
                      status: 'PENDING_GIFSY',
                      submittedAt: new Date(NOW - 20 * DAY),
                      createdAt: new Date(NOW - 20 * DAY),
                      statusHistory: [
                        { fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', metadata: { fastTrack: 'GIFSY_REJECT_RESUBMISSION' }, createdAt: new Date(NOW - HOUR) },
                      ],
                    },
                  ],
                },
              },
              { partner: { kycSubmissions: [] } }, // not started → not pending
              { partner: null },
            ]
          : [],
      ),
    );
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const where = prisma.outlet.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      clientId: 'bajaj',
      deletedAt: null,
      deactivatedAt: null,
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
    });
    const k = input.tenants.find((t) => t.clientId === 'bajaj')!.kyc;
    expect(k.ok && k.data).toMatchObject({
      field: { pending: 0, within: 0, nearing: 0, breached: 0 },
      gifsy: { pending: 1, within: 1, nearing: 0, breached: 0 },
      gifsyFastTracked: 1,
    });
  });

  it('Gifsy-wide OTP failures: pre-login + Gifsy staff users', async () => {
    prisma.otpCode.count.mockImplementation(({ where }: { where: { userId?: null; user?: { clientId: string } } }) =>
      Promise.resolve(where.userId === null ? 3 : where.user?.clientId === 'gifsy' ? 2 : 0),
    );
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    expect(input.gifsyOtpFailed).toEqual({ ok: true, data: { preLogin: 3, gifsyStaff: 2 } });
  });

  it('billing progress: Sales-Import tenants only, the dashboard loader unfiltered for the current month, mapped', async () => {
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    const deoleo = input.tenants.find((t) => t.clientId === 'deoleo')!;
    expect(deoleo.billing).toBeUndefined();
    expect(loadBillingProgress).toHaveBeenCalledTimes(1);
    expect((loadBillingProgress as jest.Mock).mock.calls[0].slice(1)).toEqual([
      'bajaj',
      { month: null, program: null, outletType: null, managerId: null },
      new Date(NOW),
    ]);
    expect(bajaj.billing).toEqual({
      ok: true,
      data: { month: '2026-11', kpiLabel: 'Total Sales', asOf: '2026-11-12', withTarget: 3, notStarted: 2, noTarget: 1, notCovered: 1, targetsOutsideRoster: 1 },
    });
  });

  it('billing failure is isolated: Sales Import still loads, billing says "couldn\'t load"', async () => {
    (loadBillingProgress as jest.Mock).mockRejectedValue(new Error('pool exhausted'));
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    const bajaj = input.tenants.find((t) => t.clientId === 'bajaj')!;
    expect(bajaj.salesImport!.ok).toBe(true);
    expect(bajaj.billing).toEqual({ ok: false, error: 'pool exhausted' });
  });

  it('voucher dispersal: window counts, the 2 h retry gate, and the still-open counts', async () => {
    prisma.voucherDispersalRow.count.mockImplementation(({ where }: { where: { status: unknown; OR?: unknown; updatedAt?: unknown; boughtAt?: unknown } }) => {
      if (where.status === 'BOUGHT' && where.OR) return Promise.resolve(where.updatedAt ? 4 : 6);
      if (where.status === 'BOUGHT') return Promise.resolve(180);
      if (where.status === 'BUY_FAILED') return Promise.resolve(where.updatedAt ? 2 : 5);
      return Promise.resolve(12); // pending
    });
    prisma.voucherDispersalRow.findMany.mockResolvedValue([
      { placeAttemptAt: new Date(NOW - 3 * HOUR), pendingSince: null }, // > 2 h → retryable
      { placeAttemptAt: new Date(NOW - 3 * HOUR), pendingSince: new Date(NOW - 30 * 60000) }, // latest anchor 30 min
      { placeAttemptAt: null, pendingSince: null }, // no anchor → not retryable (same as the service)
    ]);
    const input = await svc.collect(NOW, '13 Nov 2026', WIN);
    expect(input.voucherDispersal).toEqual({
      ok: true,
      data: { bought: 180, buyFailed: 2, messageFailed: 4, pending: 12, pendingRetryable: 1, buyFailedOpen: 5, messageFailedOpen: 6 },
    });
    const calls = prisma.voucherDispersalRow.count.mock.calls.map((c: [{ where: Record<string, unknown> }]) => c[0].where);
    const win = { gte: new Date(WIN.startMs), lt: new Date(NOW) };
    expect(calls).toContainEqual({ status: 'BOUGHT', boughtAt: win });
    expect(calls).toContainEqual({ status: 'BUY_FAILED', updatedAt: win });
    expect(calls).toContainEqual({ status: 'BUY_FAILED' });
    expect(calls).toContainEqual({ status: { in: ['QUEUED', 'BUYING', 'PENDING_RECONCILE'] } });
  });

  it('voucher dispersal failure renders "couldn\'t load" and the email still sends (a section, not a shared input)', async () => {
    prisma.programSetting.findFirst.mockResolvedValue(recipients(['ops@gifsy.in']));
    prisma.voucherDispersalRow.count.mockRejectedValue(new Error('relation does not exist'));
    const out = await svc.runDailyReports(NOW);
    expect(out.reports[0].status).toBe('sent');
    expect(sendEmail.mock.calls[0][0].html).toContain('Couldn&#39;t load the Voucher dispersal section');
    expect(sendEmail.mock.calls[0][0].subject).toContain('1 item needs attention (Gifsy-wide)');
  });
});
