import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { istDateKey } from '../common/ist-date';
import { FundController } from './fund.controller';
import { FundService } from './fund.service';
import { istDayStart } from './fund-day';

const gifsyAssumed: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '', name: 'Ops', assumed: true };
const gifsyHome: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Ops' };
const staffAssumed: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'bajaj', phone: '', name: 'Staff', assumed: true };
const clientAdmin: JwtPayload = { sub: 'c1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: 'Client' };

/** Dates relative to "now" (never a hard-coded future date). */
const daysFromToday = (n: number) => istDateKey(new Date(Date.now() + n * 86_400_000));

function makePrisma() {
  const m = () => jest.fn();
  const prisma = {
    fundReceipt: { findMany: m().mockResolvedValue([]), findFirst: m().mockResolvedValue(null), count: m().mockResolvedValue(0), create: m() },
    fundRate: { findMany: m().mockResolvedValue([]), count: m().mockResolvedValue(0), create: m() },
    fundSettings: { findUnique: m().mockResolvedValue(null), findMany: m().mockResolvedValue([]), upsert: m(), update: m().mockResolvedValue({}), updateMany: m() },
    redemptionOrder: { findMany: m().mockResolvedValue([]) },
    payoutTransaction: { findMany: m().mockResolvedValue([]) },
    creditPayoutEntry: { findMany: m().mockResolvedValue([]) },
    creditField: { findMany: m().mockResolvedValue([]) },
    tdsRecoveryEntry: { findMany: m().mockResolvedValue([]) },
    rewardCatalog: { findMany: m().mockResolvedValue([]) },
    auditLog: { create: m().mockResolvedValue({}) },
    user: { findMany: m().mockResolvedValue([]) },
    client: { findUnique: m().mockResolvedValue({ internalName: 'Bajaj', branding: { displayName: 'Bajaj Consumer' } }) },
    $executeRaw: m().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

function makeService(prisma = makePrisma(), mail = { sendEmail: jest.fn().mockResolvedValue({ skipped: false, accepted: ['a@x.com'], rejected: [] }), isEmailConfigured: jest.fn().mockReturnValue(true) }) {
  return { svc: new FundService(prisma as never, mail as never), prisma, mail };
}

/** Every `where` passed to a tenant-data read in the loader. */
function whereClientIds(prisma: ReturnType<typeof makePrisma>): unknown[] {
  const calls = [
    ...prisma.fundReceipt.findMany.mock.calls,
    ...prisma.fundRate.findMany.mock.calls,
    ...prisma.redemptionOrder.findMany.mock.calls,
    ...prisma.payoutTransaction.findMany.mock.calls,
    ...prisma.creditPayoutEntry.findMany.mock.calls,
    ...prisma.creditField.findMany.mock.calls,
    ...prisma.tdsRecoveryEntry.findMany.mock.calls,
  ];
  return calls.map(([arg]) => {
    const w = (arg as { where: Record<string, unknown> }).where;
    return (w.clientId as string | undefined) ?? (w.partner as { clientId?: string } | undefined)?.clientId;
  });
}

describe('FundService — tenant scope + roles', () => {
  it('an un-assumed Gifsy owner has no client context → 400 (reads and writes)', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.summary(gifsyHome)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.recordReceipt(gifsyHome, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: 'U' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fundReceipt.findMany).not.toHaveBeenCalled();
  });

  it('CLIENT_ADMIN reads ONLY its own tenant (every source query pinned to the JWT clientId) and cannot manage', async () => {
    const { svc, prisma } = makeService();
    const s = await svc.summary(clientAdmin);
    expect(s.clientId).toBe('deoleo');
    expect(s.canManage).toBe(false);
    const ids = whereClientIds(prisma);
    expect(ids.length).toBeGreaterThanOrEqual(7);
    expect(new Set(ids)).toEqual(new Set(['deoleo']));
  });

  it('an assumed Gifsy operator reads the ASSUMED tenant and can manage', async () => {
    const { svc, prisma } = makeService();
    const s = await svc.summary(gifsyAssumed);
    expect(s.canManage).toBe(true);
    expect(new Set(whereClientIds(prisma))).toEqual(new Set(['bajaj']));
  });

  it('CLIENT_ADMIN writes are refused in the service too (defence in depth) — nothing is written', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.recordReceipt(clientAdmin, { amountRupees: 10, receivedOn: daysFromToday(0), referenceNumber: 'U1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.recordAdjustment(clientAdmin, { amountRupees: 10, date: daysFromToday(0), reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.recordOpening(clientAdmin, { amountRupees: 10, asOfDate: daysFromToday(0) })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateAlerts(clientAdmin, { thresholdRupees: 1, alertRecipients: ['a@b.com'] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setAgencyFee(clientAdmin, { feeType: 'PERCENT', percent: 5, effectiveFrom: daysFromToday(0) })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setBrandDiscount(clientAdmin, { brandKey: 'brand:amazon', brandLabel: 'Amazon', percent: 3, effectiveFrom: daysFromToday(0) })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.fundReceipt.create).not.toHaveBeenCalled();
    expect(prisma.fundRate.create).not.toHaveBeenCalled();
    expect(prisma.fundSettings.upsert).not.toHaveBeenCalled();
  });

  it('controller: reads = GIFSY_ADMIN + CLIENT_ADMIN (payouts:read); writes = GIFSY_ADMIN only (payouts:manage_fund)', () => {
    const p = FundController.prototype as unknown as Record<string, object>;
    for (const r of ['summary', 'statement', 'entries', 'settings', 'export']) {
      expect(Reflect.getMetadata(ROLES_KEY, p[r])).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, p[r])).toBe('payouts:read');
    }
    for (const w of ['recordReceipt', 'recordAdjustment', 'recordOpening', 'updateAlerts', 'setAgencyFee', 'setBrandDiscount']) {
      expect(Reflect.getMetadata(ROLES_KEY, p[w])).toEqual(['GIFSY_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, p[w])).toBe('payouts:manage_fund');
    }
  });
});

describe('FundService — receipts / adjustments / opening balance', () => {
  it('records a receipt: rupees → paise ONCE (the old ×100 bug), start of the IST day, audited, inside one transaction', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', ...data }));
    const day = daysFromToday(-1);
    const res = await svc.recordReceipt(gifsyAssumed, { amountRupees: 1500.5, receivedOn: day, referenceNumber: ' UTR123 ' });
    expect(res.amountPaise).toBe(150_050);
    const data = prisma.fundReceipt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'bajaj', entryType: 'RECEIPT', amountPaise: 150_050n, referenceNumber: 'UTR123', createdByUserId: 'g1' });
    expect(data.receivedAt).toEqual(istDayStart(day));
    expect(prisma.$executeRaw).toHaveBeenCalled(); // per-client advisory lock
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ entityType: 'FUND_RECEIPT', actorId: 'g1' });
  });

  it('a GIFSY_STAFF assumed into the tenant may record (route permission decides upstream)', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.create.mockResolvedValue({ id: 'r1', receiptNumber: 'FR-1' });
    await expect(svc.recordReceipt(staffAssumed, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: 'U' })).resolves.toBeTruthy();
  });

  it('refuses a future receipt date, a duplicate UTR and a receipt dated before the opening balance', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(2), referenceNumber: 'U' })).rejects.toBeInstanceOf(BadRequestException);
    prisma.fundReceipt.findFirst.mockImplementation(async ({ where }: { where: { entryType: string } }) =>
      where.entryType === 'RECEIPT' ? { receiptNumber: 'FR-OLD' } : null,
    );
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: 'U' })).rejects.toBeInstanceOf(ConflictException);
    prisma.fundReceipt.findFirst.mockImplementation(async ({ where }: { where: { entryType: string } }) =>
      where.entryType === 'OPENING_BALANCE' ? { receivedAt: istDayStart(daysFromToday(-1)), receiptNumber: 'FO-1' } : null,
    );
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(-3), referenceNumber: 'U2' })).rejects.toThrow(/before the opening balance date/);
    expect(prisma.fundReceipt.create).not.toHaveBeenCalled();
  });

  it('adjustment: a reason is mandatory, ₹0 refused, negative amounts allowed', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.recordAdjustment(gifsyAssumed, { amountRupees: 5, date: daysFromToday(0), reason: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.recordAdjustment(gifsyAssumed, { amountRupees: 0, date: daysFromToday(0), reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    prisma.fundReceipt.create.mockResolvedValue({ id: 'a1', receiptNumber: 'FA-1' });
    await svc.recordAdjustment(gifsyAssumed, { amountRupees: -250.25, date: daysFromToday(0), reason: 'Hubble credit note reversal' });
    expect(prisma.fundReceipt.create.mock.calls[0][0].data).toMatchObject({ entryType: 'ADJUSTMENT', amountPaise: -25_025n, reason: 'Hubble credit note reversal' });
  });

  it('opening balance: only one per client (409) and never after existing entries', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.findFirst.mockResolvedValueOnce({ receiptNumber: 'FO-1' });
    await expect(svc.recordOpening(gifsyAssumed, { amountRupees: 100, asOfDate: daysFromToday(0) })).rejects.toBeInstanceOf(ConflictException);
    prisma.fundReceipt.count.mockResolvedValueOnce(2);
    await expect(svc.recordOpening(gifsyAssumed, { amountRupees: 100, asOfDate: daysFromToday(0) })).rejects.toThrow(/dated before/);
    prisma.fundReceipt.create.mockResolvedValue({ id: 'o1', receiptNumber: 'FO-1' });
    await svc.recordOpening(gifsyAssumed, { amountRupees: 100000, asOfDate: daysFromToday(-5) });
    expect(prisma.fundReceipt.create.mock.calls[0][0].data).toMatchObject({ entryType: 'OPENING_BALANCE', amountPaise: 10_000_000n });
  });
});

describe('FundService — settings + rates', () => {
  it('threshold needs at least one recipient; recipients are normalised; audited', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.updateAlerts(gifsyAssumed, { thresholdRupees: 5000, alertRecipients: [] })).rejects.toBeInstanceOf(BadRequestException);
    prisma.fundSettings.upsert.mockResolvedValue({ lowBalanceThresholdPaise: 500_000n });
    const r = await svc.updateAlerts(gifsyAssumed, { thresholdRupees: 5000, alertRecipients: ['A@X.com', 'a@x.com ', 'b@y.com'] });
    expect(r.alertRecipients).toEqual(['a@x.com', 'b@y.com']);
    expect(prisma.fundSettings.upsert.mock.calls[0][0].create).toMatchObject({ clientId: 'bajaj', lowBalanceThresholdPaise: 500_000n });
    expect(prisma.auditLog.create.mock.calls[0][0].data.entityType).toBe('FUND_SETTINGS');
  });

  it('agency fee: % stored as basis points; flat as paise; mismatched fields refused', async () => {
    const { svc, prisma } = makeService();
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f', ...data }));
    await svc.setAgencyFee(gifsyAssumed, { feeType: 'PERCENT', percent: 2.5, effectiveFrom: daysFromToday(3) });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ kind: 'AGENCY_FEE', feeType: 'PERCENT', rateBps: 250, flatPaise: null, clientId: 'bajaj' });
    await svc.setAgencyFee(gifsyAssumed, { feeType: 'FLAT', flatRupees: 15, effectiveFrom: daysFromToday(0) });
    expect(prisma.fundRate.create.mock.calls[1][0].data).toMatchObject({ feeType: 'FLAT', flatPaise: 1_500n, rateBps: null });
    await expect(svc.setAgencyFee(gifsyAssumed, { feeType: 'PERCENT', effectiveFrom: daysFromToday(0) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setAgencyFee(gifsyAssumed, { feeType: 'FLAT', percent: 3, flatRupees: 1, effectiveFrom: daysFromToday(0) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('brand discount: only a known brand-key shape; stored per brand in bps', async () => {
    const { svc, prisma } = makeService();
    prisma.fundRate.create.mockResolvedValue({ id: 'd', kind: 'VOUCHER_DISCOUNT', effectiveFrom: new Date(), createdAt: new Date() });
    await expect(svc.setBrandDiscount(gifsyAssumed, { brandKey: 'amazon', brandLabel: 'Amazon', percent: 3, effectiveFrom: daysFromToday(0) })).rejects.toBeInstanceOf(BadRequestException);
    await svc.setBrandDiscount(gifsyAssumed, { brandKey: 'hubble:P1', brandLabel: 'Amazon Pay', percent: 3, effectiveFrom: daysFromToday(0) });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ kind: 'VOUCHER_DISCOUNT', brandKey: 'hubble:P1', rateBps: 300 });
  });

  it('settings lists the catalogue voucher brands (grouped by brand key) with the rate in force', async () => {
    const { svc, prisma } = makeService();
    prisma.rewardCatalog.findMany.mockResolvedValue([
      { id: 'i1', name: 'Amazon ₹500', metadata: { hubbleProductId: 'P1' }, deletedAt: null },
      { id: 'i2', name: 'Amazon ₹1000', metadata: { hubbleProductId: 'P1' }, deletedAt: null },
      { id: 'i3', name: 'Old card', metadata: null, deletedAt: new Date() },
    ]);
    prisma.fundRate.findMany.mockResolvedValue([
      { id: 'd1', kind: 'VOUCHER_DISCOUNT', brandKey: 'hubble:P1', brandLabel: 'Amazon', rateBps: 300, effectiveFrom: new Date(Date.now() - 86_400_000), createdAt: new Date(), createdById: null, note: null, feeType: null, flatPaise: null },
    ]);
    const s = await svc.settings(clientAdmin);
    expect(s.canManage).toBe(false);
    const amazon = s.brands.find((b) => b.brandKey === 'hubble:P1')!;
    expect(amazon.items).toEqual(['Amazon ₹500', 'Amazon ₹1000']);
    expect(amazon.currentRateBps).toBe(300);
    expect(s.brands.find((b) => b.brandKey === 'item:i3')!.items).toEqual(['Old card (deleted)']);
    expect(prisma.rewardCatalog.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
  });
});

describe('FundService — daily low-balance e-mail', () => {
  const today = () => istDateKey(new Date());
  const lowSettings = (o: Record<string, unknown> = {}) => ({ clientId: 'bajaj', lowBalanceThresholdPaise: 1_000n, alertRecipients: ['ops@bajaj.test'], lowAlertLastSentOn: null, ...o });

  it('low + not yet sent today → claims today and sends ONE e-mail; balance never blocks anything', async () => {
    const { svc, prisma, mail } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings()]);
    prisma.fundSettings.updateMany.mockResolvedValue({ count: 1 });
    const out = await svc.runLowBalanceAlerts(Date.now());
    expect(out.get('bajaj')).toMatchObject({ status: 'sent', recipients: 1 });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail.mock.calls[0][0].to).toEqual(['ops@bajaj.test']);
    expect(mail.sendEmail.mock.calls[0][0].subject).toContain('Bajaj Consumer');
    expect(prisma.fundSettings.updateMany.mock.calls[0][0].data).toEqual({ lowAlertLastSentOn: today() });
  });

  it('already sent today → no e-mail; a lost claim race → no e-mail', async () => {
    const { svc, prisma, mail } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings({ lowAlertLastSentOn: today() })]);
    expect((await svc.runLowBalanceAlerts(Date.now())).get('bajaj')!.status).toBe('already-sent-today');
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings()]);
    prisma.fundSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await svc.runLowBalanceAlerts(Date.now())).get('bajaj')!.status).toBe('already-sent-today');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('balance at/above the threshold → not-low, no e-mail', async () => {
    const { svc, prisma, mail } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings({ lowBalanceThresholdPaise: 0n })]);
    expect((await svc.runLowBalanceAlerts(Date.now())).get('bajaj')!.status).toBe('not-low');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('a send failure is stored loudly and today\'s claim released (a re-run can retry)', async () => {
    const { svc, prisma, mail } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings({ lowAlertLastSentOn: '2000-01-01' })]);
    prisma.fundSettings.updateMany.mockResolvedValue({ count: 1 });
    mail.sendEmail.mockRejectedValue(new Error('SMTP down'));
    const out = await svc.runLowBalanceAlerts(Date.now());
    expect(out.get('bajaj')).toMatchObject({ status: 'failed' });
    expect(out.get('bajaj')!.error).toContain('SMTP down');
    expect(prisma.fundSettings.update).toHaveBeenCalledWith({
      where: { clientId: 'bajaj' },
      data: { lowAlertLastSentOn: '2000-01-01', lowAlertLastError: expect.stringContaining('SMTP down') },
    });
  });

  it('e-mail not configured → not sent, error recorded (never reported as delivered)', async () => {
    const { svc, prisma, mail } = makeService();
    mail.isEmailConfigured.mockReturnValue(false);
    prisma.fundSettings.findMany.mockResolvedValue([lowSettings()]);
    expect((await svc.runLowBalanceAlerts(Date.now())).get('bajaj')!.status).toBe('email-not-configured');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
});
