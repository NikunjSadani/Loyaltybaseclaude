import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { istDateKey } from '../common/ist-date';
import { FundConsoleController, FundController } from './fund.controller';
import { CLIENT_ALERT_ERROR_TEXT, FundService, fundAlertTarget } from './fund.service';
import { istDayStart } from './fund-day';

// The confirm token is an HMAC keyed with the API's JWT_SECRET (round 5 N6).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-fund-specs';

const gifsyAssumed: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '', name: 'Ops', assumed: true };
const gifsyHome: JwtPayload = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Ops' };
const staffAssumed: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'bajaj', phone: '', name: 'Staff', assumed: true, gifsyRoleId: 'role-1' };
const staffHome: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: 'Staff', gifsyRoleId: 'role-1' };
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
    creditReversal: { findMany: m().mockResolvedValue([]) },
    tdsRecoveryEntry: { findMany: m().mockResolvedValue([]) },
    rewardCatalog: { findMany: m().mockResolvedValue([]), findFirst: m().mockResolvedValue(null) },
    auditLog: { create: m().mockResolvedValue({}) },
    user: { findMany: m().mockResolvedValue([]) },
    client: { findUnique: m().mockResolvedValue({ id: 'bajaj', status: 'ACTIVE', internalName: 'Bajaj', branding: { displayName: 'Bajaj Consumer' } }) },
    $executeRaw: m().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

function makeService(opts: { staffPerms?: string[]; grant?: boolean } = {}) {
  const prisma = makePrisma();
  const mail = {
    sendEmail: jest.fn().mockResolvedValue({ skipped: false, accepted: ['a@x.com'], rejected: [] }),
    isEmailConfigured: jest.fn().mockReturnValue(true),
  };
  const roles = { getPermissions: jest.fn().mockResolvedValue(new Set(opts.staffPerms ?? [])) };
  const grants = { hasGrantUncached: jest.fn().mockResolvedValue(opts.grant ?? true) };
  return { svc: new FundService(prisma as never, mail as never, roles as never, grants as never), prisma, mail, roles, grants };
}

/** The clientId every tenant-data read was pinned to. */
function whereClientIds(prisma: ReturnType<typeof makePrisma>): unknown[] {
  const calls = [
    ...prisma.fundReceipt.findMany.mock.calls,
    ...prisma.fundRate.findMany.mock.calls,
    ...prisma.redemptionOrder.findMany.mock.calls,
    ...prisma.payoutTransaction.findMany.mock.calls,
    ...prisma.creditPayoutEntry.findMany.mock.calls,
    ...prisma.creditField.findMany.mock.calls,
    ...prisma.creditReversal.findMany.mock.calls,
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
    expect(s.settingsConsoleHref).toBeNull();
    const ids = whereClientIds(prisma);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids)).toEqual(new Set(['deoleo']));
  });

  it('an assumed Gifsy owner reads the ASSUMED tenant, can manage, and gets the console link', async () => {
    const { svc, prisma } = makeService();
    const s = await svc.summary(gifsyAssumed);
    expect(s.canManage).toBe(true);
    expect(s.settingsConsoleHref).toBe('/admin/fund/settings');
    expect(new Set(whereClientIds(prisma))).toEqual(new Set(['bajaj']));
  });

  it('B4: GIFSY_STAFF canManage follows its role\'s payouts:manage_fund — not merely "is Gifsy"', async () => {
    expect(await makeService({ staffPerms: ['payouts:read'] }).svc.canManage(staffAssumed)).toBe(false);
    expect(await makeService({ staffPerms: ['payouts:read', 'payouts:manage_fund'] }).svc.canManage(staffAssumed)).toBe(true);
    const { svc } = makeService({ staffPerms: ['payouts:read'] });
    await expect(svc.recordReceipt(staffAssumed, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: 'U' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CLIENT_ADMIN writes are refused in the service too (defence in depth) — nothing is written', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.recordReceipt(clientAdmin, { amountRupees: 10, receivedOn: daysFromToday(0), referenceNumber: 'U1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.recordAdjustment(clientAdmin, { amountRupees: 10, date: daysFromToday(0), reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.recordOpening(clientAdmin, { amountRupees: 10, asOfDate: daysFromToday(0) })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateAlerts(clientAdmin, 'deoleo', { thresholdRupees: 1, alertRecipients: ['a@b.com'] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setAgencyFee(clientAdmin, 'deoleo', { feeType: 'PERCENT', percent: 5, effectiveFrom: daysFromToday(3) })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setItemDiscount(clientAdmin, 'deoleo', { rewardId: 'rw', percent: 3, effectiveFrom: daysFromToday(3) })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.fundReceipt.create).not.toHaveBeenCalled();
    expect(prisma.fundRate.create).not.toHaveBeenCalled();
    expect(prisma.fundSettings.upsert).not.toHaveBeenCalled();
  });

  it('controllers: tenant reads = GIFSY_ADMIN + CLIENT_ADMIN; tenant writes + console = Gifsy only with the right permission', () => {
    const p = FundController.prototype as unknown as Record<string, object>;
    for (const r of ['summary', 'statement', 'entries', 'settings', 'export']) {
      expect(Reflect.getMetadata(ROLES_KEY, p[r])).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, p[r])).toBe('payouts:read');
    }
    for (const w of ['recordReceipt', 'recordAdjustment', 'recordOpening']) {
      expect(Reflect.getMetadata(ROLES_KEY, p[w])).toEqual(['GIFSY_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, p[w])).toBe('payouts:manage_fund');
    }
    // D6: no settings writes on the tenant controller any more.
    for (const gone of ['updateAlerts', 'setAgencyFee', 'setBrandDiscount', 'setItemDiscount']) expect(p[gone]).toBeUndefined();
    const c = FundConsoleController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, c.get)).toEqual(['GIFSY_ADMIN']);
    expect(Reflect.getMetadata(PERMISSION_KEY, c.get)).toBe('payouts:read');
    for (const w of ['updateAlerts', 'setAgencyFee', 'setItemDiscount']) {
      expect(Reflect.getMetadata(ROLES_KEY, c[w])).toEqual(['GIFSY_ADMIN']);
      expect(Reflect.getMetadata(PERMISSION_KEY, c[w])).toBe('payouts:manage_fund');
    }
  });
});

describe('FundService — console target (owner D6)', () => {
  it('GIFSY_ADMIN may target any existing client; unknown / the gifsy operator row → 404', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.consoleClient(gifsyHome, 'bajaj', true)).resolves.toBe('bajaj');
    prisma.client.findUnique.mockResolvedValueOnce(null);
    await expect(svc.consoleClient(gifsyHome, 'nope', false)).rejects.toBeInstanceOf(NotFoundException);
    prisma.client.findUnique.mockResolvedValueOnce({ id: 'gifsy' });
    await expect(svc.consoleClient(gifsyHome, 'gifsy', false)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GIFSY_STAFF needs the permission AND a tenant grant for that client', async () => {
    await expect(makeService({ staffPerms: ['payouts:read'], grant: true }).svc.consoleClient(staffHome, 'bajaj', false)).resolves.toBe('bajaj');
    await expect(makeService({ staffPerms: ['payouts:read'], grant: true }).svc.consoleClient(staffHome, 'bajaj', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService({ staffPerms: ['payouts:read', 'payouts:manage_fund'], grant: false }).svc.consoleClient(staffHome, 'bajaj', true)).rejects.toThrow(/do not have access/);
  });

  it('a client admin can never use the console', async () => {
    await expect(makeService().svc.consoleSettings(clientAdmin, 'deoleo')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('FundService — receipts / adjustments / opening balance', () => {
  it('records a receipt: rupees → paise ONCE, start of the IST day, audited, inside one transaction', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', ...data }));
    const day = daysFromToday(-1);
    const res = await svc.recordReceipt(gifsyAssumed, { amountRupees: 1500.5, receivedOn: day, referenceNumber: ' UTR123 ' });
    expect(res.amountPaise).toBe(150_050);
    const data = prisma.fundReceipt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'bajaj', entryType: 'RECEIPT', amountPaise: 150_050n, referenceNumber: 'UTR123', createdByUserId: 'g1' });
    expect(data.receivedAt).toEqual(istDayStart(day));
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ entityType: 'FUND_RECEIPT', actorId: 'g1' });
  });

  it('B7: the duplicate-UTR check is trimmed + case-insensitive', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.findFirst.mockImplementation(async ({ where }: { where: { entryType: string } }) =>
      where.entryType === 'RECEIPT' ? { receiptNumber: 'FR-OLD' } : null,
    );
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: '  utr123 ' })).rejects.toBeInstanceOf(ConflictException);
    const dupCall = prisma.fundReceipt.findFirst.mock.calls.find(([a]) => (a as { where: { entryType: string } }).where.entryType === 'RECEIPT')!;
    expect((dupCall[0] as { where: { referenceNumber: unknown } }).where.referenceNumber).toEqual({ equals: 'utr123', mode: 'insensitive' });
  });

  it('B9: a receipt-number clash (P2002) is a clear 409 and nothing is saved', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(0), referenceNumber: 'U' })).rejects.toThrow(/same number — nothing was saved/);
    await expect(svc.recordAdjustment(gifsyAssumed, { amountRupees: 1, date: daysFromToday(0), reason: 'r' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a future receipt date and a receipt dated before the opening balance', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.recordReceipt(gifsyAssumed, { amountRupees: 1, receivedOn: daysFromToday(2), referenceNumber: 'U' })).rejects.toBeInstanceOf(BadRequestException);
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
    await svc.recordAdjustment(gifsyAssumed, { amountRupees: -250.25, date: daysFromToday(0), reason: 'credit note' });
    expect(prisma.fundReceipt.create.mock.calls[0][0].data).toMatchObject({ entryType: 'ADJUSTMENT', amountPaise: -25_025n, reason: 'credit note' });
  });

  it('opening balance: once only (D2 — 409 says it cannot be changed) and never after existing entries', async () => {
    const { svc, prisma } = makeService();
    prisma.fundReceipt.findFirst.mockResolvedValueOnce({ receiptNumber: 'FO-1' });
    await expect(svc.recordOpening(gifsyAssumed, { amountRupees: 100, asOfDate: daysFromToday(0) })).rejects.toThrow(/cannot be changed/);
    prisma.fundReceipt.count.mockResolvedValueOnce(2);
    await expect(svc.recordOpening(gifsyAssumed, { amountRupees: 100, asOfDate: daysFromToday(0) })).rejects.toThrow(/dated before/);
    prisma.fundReceipt.create.mockResolvedValue({ id: 'o1', receiptNumber: 'FO-1' });
    await svc.recordOpening(gifsyAssumed, { amountRupees: 100000, asOfDate: daysFromToday(-5) });
    expect(prisma.fundReceipt.create.mock.calls[0][0].data).toMatchObject({ entryType: 'OPENING_BALANCE', amountPaise: 10_000_000n });
  });
});

describe('FundService — console settings + rates (D1, D4, D6)', () => {
  it('alerts: threshold needs a recipient; recipients normalised; audited; targets the console slug', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.updateAlerts(gifsyHome, 'bajaj', { thresholdRupees: 5000, alertRecipients: [] })).rejects.toBeInstanceOf(BadRequestException);
    prisma.fundSettings.upsert.mockResolvedValue({ lowBalanceThresholdPaise: 500_000n });
    const r = await svc.updateAlerts(gifsyHome, 'bajaj', { thresholdRupees: 5000, alertRecipients: ['A@X.com', 'a@x.com ', 'b@y.com'] });
    expect(r.alertRecipients).toEqual(['a@x.com', 'b@y.com']);
    expect(prisma.fundSettings.upsert.mock.calls[0][0].create).toMatchObject({ clientId: 'bajaj', lowBalanceThresholdPaise: 500_000n });
    expect(prisma.auditLog.create.mock.calls[0][0].data.entityType).toBe('FUND_SETTINGS');
  });

  it('a FUTURE-dated fee saves at once (scheduled), stored in bps / paise; mismatched fields refused', async () => {
    const { svc, prisma } = makeService();
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f', ...data }));
    const res = await svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'PERCENT', percent: 2.5, effectiveFrom: daysFromToday(3) });
    expect(res).toMatchObject({ saved: true, scheduled: true });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ kind: 'AGENCY_FEE', feeType: 'PERCENT', rateBps: 250, flatPaise: null, clientId: 'bajaj', repricedLines: null });
    await svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'FLAT', flatRupees: 15, effectiveFrom: daysFromToday(2) });
    expect(prisma.fundRate.create.mock.calls[1][0].data).toMatchObject({ feeType: 'FLAT', flatPaise: 1_500n, rateBps: null });
    await expect(svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'PERCENT', effectiveFrom: daysFromToday(1) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'FLAT', percent: 3, flatRupees: 1, effectiveFrom: daysFromToday(1) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('D1: a BACK-DATED fee returns a preview (lines re-priced + balance change) and saves only with the matching token', async () => {
    const { svc, prisma } = makeService();
    const committed = new Date(Date.now() - 2 * 86_400_000);
    prisma.payoutTransaction.findMany.mockResolvedValue([
      { id: 't1', amountPaise: 100_000n, status: 'SUCCESS', payoutMode: 'UPI', createdAt: committed, completedAt: committed, reversedAt: null, updatedAt: committed, providerRefId: 'U', redemptionOrderId: null, batch: null },
    ]);
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f', ...data }));
    const body = { feeType: 'PERCENT' as const, percent: 2, effectiveFrom: daysFromToday(-5) };
    const preview = await svc.setAgencyFee(gifsyHome, 'bajaj', body);
    expect(preview).toMatchObject({ saved: false, requiresConfirmation: true, preview: { linesRepriced: 1, deltaPaise: -2_000 } });
    expect(prisma.fundRate.create).not.toHaveBeenCalled();
    // Wrong / stale token → 409, nothing saved.
    await expect(svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken: 'bogus' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.fundRate.create).not.toHaveBeenCalled();
    const token = (preview as { confirmToken: string }).confirmToken;
    const saved = await svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken: token });
    expect(saved).toMatchObject({ saved: true, scheduled: false, linesRepriced: 1, deltaPaise: -2_000 });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ repricedLines: 1, repriceDeltaPaise: -2_000n, repricedFrom: committed });
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.newValues).toMatchObject({ backdated: true, linesRepriced: 1, balanceDeltaPaise: '-2000' });
  });

  it('A2/B3: the confirm is atomic — lock + preview recomputed INSIDE the transaction; a second confirm with the same token (double-click) is refused', async () => {
    const { svc, prisma } = makeService();
    const committed = new Date(Date.now() - 2 * 86_400_000);
    prisma.payoutTransaction.findMany.mockResolvedValue([
      { id: 't1', amountPaise: 100_000n, status: 'SUCCESS', payoutMode: 'UPI', createdAt: committed, completedAt: committed, reversedAt: null, updatedAt: committed, providerRefId: 'U', redemptionOrderId: null, batch: null },
    ]);
    const saved: Array<Record<string, unknown>> = [];
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'f' + saved.length, createdAt: new Date(), ...data };
      saved.push(row);
      return row;
    });
    // The rate history the loader sees includes what was saved so far (as the DB would, under the lock).
    prisma.fundRate.findMany.mockImplementation(async () => saved);
    const body = { feeType: 'PERCENT' as const, percent: 2, effectiveFrom: daysFromToday(-5) };
    const { confirmToken } = (await svc.setAgencyFee(gifsyHome, 'bajaj', body)) as { confirmToken: string };
    await svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken });
    await expect(svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken })).rejects.toBeInstanceOf(ConflictException);
    expect(saved).toHaveLength(1);
    // The lock is taken inside the same transaction that recomputes + writes.
    const lockCall = prisma.$executeRaw.mock.calls.find((c) => String(c[0]).includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(prisma.$transaction.mock.calls.at(-1)![1]).toMatchObject({ timeout: 120_000 });
  });

  it('round 4 item 7: spend committed AFTER the preview never invalidates the token (no endless 409s); it is not counted as re-priced', async () => {
    const { svc, prisma } = makeService();
    const committed = new Date(Date.now() - 2 * 86_400_000);
    const txn = (id: string, at: Date) => ({ id, amountPaise: 100_000n, status: 'SUCCESS', payoutMode: 'UPI', createdAt: at, completedAt: at, reversedAt: null, updatedAt: at, providerRefId: 'U', redemptionOrderId: null, batch: null });
    prisma.payoutTransaction.findMany.mockResolvedValue([txn('t1', committed)]);
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f', createdAt: new Date(), ...data }));
    const body = { feeType: 'PERCENT' as const, percent: 2, effectiveFrom: daysFromToday(-5) };
    const pv = (await svc.setAgencyFee(gifsyHome, 'bajaj', body)) as { confirmToken: string; preview: { linesRepriced: number } };
    expect(pv.confirmToken).toMatch(/^\d{10,16}\.[0-9a-f]{32}$/);
    // N6: the token is an HMAC — a forged one with the right shape is refused.
    const [ms] = pv.confirmToken.split('.');
    await expect(svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken: `${ms}.${'0'.repeat(32)}` })).rejects.toBeInstanceOf(ConflictException);
    // New spend lands between the preview and the confirm.
    prisma.payoutTransaction.findMany.mockResolvedValue([txn('t1', committed), txn('t2', new Date(Date.now() + 1_000))]);
    const saved = await svc.setAgencyFee(gifsyHome, 'bajaj', { ...body, confirmToken: pv.confirmToken });
    // The token still verifies (only pre-preview spend is in it) — and the figures STORED are recomputed at the confirm,
    // so they include the new line committed in between (round 5 N6).
    expect(saved).toMatchObject({ saved: true, linesRepriced: 2, deltaPaise: -4_000 });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ repricedLines: 2, repriceDeltaPaise: -4_000n });
  });

  it('B5: the audit row of a FUTURE-dated rate names the rate in force before it', async () => {
    const { svc, prisma } = makeService();
    const past = new Date(Date.now() - 30 * 86_400_000);
    prisma.fundRate.findMany.mockResolvedValue([{ kind: 'AGENCY_FEE', feeType: 'PERCENT', rateBps: 150, flatPaise: null, effectiveFrom: past, createdAt: past, rewardId: null }]);
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f', ...data }));
    await svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'PERCENT', percent: 2, effectiveFrom: daysFromToday(4) });
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.oldValues).toMatchObject({ feeType: 'PERCENT', rateBps: 150, effectiveFrom: past.toISOString() });
    expect(audit.newValues).toMatchObject({ rateBps: 200, backdated: false });
  });

  it('D1: same-day effective counts as back-dated (re-prices lines committed earlier today)', async () => {
    const { svc } = makeService();
    const res = await svc.setAgencyFee(gifsyHome, 'bajaj', { feeType: 'FLAT', flatRupees: 5, effectiveFrom: daysFromToday(0) });
    expect(res).toMatchObject({ requiresConfirmation: true });
  });

  it('D4: discount per voucher ITEM of THIS client (another client\'s item refused)', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setItemDiscount(gifsyHome, 'bajaj', { rewardId: 'rw-other', percent: 3, effectiveFrom: daysFromToday(2) })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.rewardCatalog.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'rw-other', clientId: 'bajaj', redemptionMode: 'GIFT_CARD' });
    prisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'rw1', name: 'Amazon ₹500' });
    prisma.fundRate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd', ...data }));
    await svc.setItemDiscount(gifsyHome, 'bajaj', { rewardId: 'rw1', percent: 3, effectiveFrom: daysFromToday(2) });
    expect(prisma.fundRate.create.mock.calls[0][0].data).toMatchObject({ kind: 'VOUCHER_DISCOUNT', rewardId: 'rw1', rewardLabel: 'Amazon ₹500', rateBps: 300 });
  });

  it('settings view lists the voucher items with current + scheduled rates; a client admin gets a client-safe alert error', async () => {
    const { svc, prisma } = makeService();
    prisma.rewardCatalog.findMany.mockResolvedValue([
      { id: 'i1', name: 'Amazon ₹500', code: 'AMZ500', metadata: { brand: 'Amazon' }, deletedAt: null, status: 'ACTIVE' },
      { id: 'i3', name: 'Old card', code: 'OLD', metadata: null, deletedAt: new Date(), status: 'INACTIVE' },
    ]);
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 3 * 86_400_000);
    prisma.fundRate.findMany.mockResolvedValue([
      { id: 'd2', kind: 'VOUCHER_DISCOUNT', rewardId: 'i1', rewardLabel: 'Amazon ₹500', rateBps: 400, effectiveFrom: future, createdAt: new Date(), createdById: null, note: null, feeType: null, flatPaise: null, repricedLines: null, repriceDeltaPaise: null, repricedFrom: null },
      { id: 'd1', kind: 'VOUCHER_DISCOUNT', rewardId: 'i1', rewardLabel: 'Amazon ₹500', rateBps: 300, effectiveFrom: past, createdAt: past, createdById: null, note: null, feeType: null, flatPaise: null, repricedLines: null, repriceDeltaPaise: null, repricedFrom: null },
    ]);
    prisma.fundSettings.findUnique.mockResolvedValue({ lowBalanceThresholdPaise: 100n, alertRecipients: ['a@b.com'], lowAlertLastSentOn: null, lowAlertLastError: 'SMTP 550 mailbox unavailable', lowAlertLastRecipients: 1 });
    const s = await svc.tenantSettings(clientAdmin);
    expect(s.managedInConsole).toBe(true);
    expect(s.consoleHref).toBeNull();
    expect(s.lastAlertError).toBe(CLIENT_ALERT_ERROR_TEXT);
    expect(s.items[0]).toMatchObject({ rewardId: 'i1', brandText: 'Amazon', currentRateBps: 300, scheduledRateBps: 400 });
    expect(s.items[1]).toMatchObject({ deleted: true, active: false, currentRateBps: null });
    expect(prisma.rewardCatalog.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    const g = await svc.consoleSettings(gifsyHome, 'bajaj');
    expect(g.lastAlertError).toBe('SMTP 550 mailbox unavailable');
    expect(g.consoleHref).toBe('/admin/fund/settings');
  });
});

describe('FundService — digest line + daily low-balance e-mail (A7 / B5 / B6)', () => {
  const today = () => istDateKey(new Date());
  const ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.REPORTS_RECIPIENT_DOMAINS;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });
  /** A set-up client whose balance (₹0 opening) is below a ₹10 threshold. */
  function lowClient(o: { settings?: Record<string, unknown>; opening?: boolean } = {}) {
    const ctx = makeService();
    ctx.prisma.fundSettings.findUnique.mockResolvedValue({
      clientId: 'bajaj',
      lowBalanceThresholdPaise: 1_000n,
      alertRecipients: ['ops@bajaj.test'],
      lowAlertLastSentOn: null,
      lowAlertLastError: null,
      lowAlertLastRecipients: null,
      ...(o.settings ?? {}),
    });
    ctx.prisma.fundReceipt.count.mockResolvedValue(1);
    if (o.opening !== false) {
      ctx.prisma.fundReceipt.findMany.mockResolvedValue([
        { id: 'o', entryType: 'OPENING_BALANCE', receiptNumber: 'FO-1', amountPaise: 0n, receivedAt: new Date(Date.now() - 10 * 86_400_000), paymentMode: 'OPENING_BALANCE', referenceNumber: null, bankName: null, notes: null, reason: null, createdByUserId: null, createdAt: new Date() },
      ]);
    }
    ctx.prisma.fundSettings.updateMany.mockResolvedValue({ count: 1 });
    return ctx;
  }

  it('fund-alert target is fail-safe: off unless FUND_ALERTS_LIVE=true; a valid test address otherwise', () => {
    expect(fundAlertTarget({})).toEqual({ mode: 'off' });
    expect(fundAlertTarget({ FUND_ALERTS_TEST_RECIPIENT: 'qa@gifsy.in' })).toEqual({ mode: 'test', to: 'qa@gifsy.in' });
    // Re-audit B4: the test address must be INTERNAL (REPORTS_RECIPIENT_DOMAINS, default gifsy.in) — else refused loudly.
    expect(fundAlertTarget({ FUND_ALERTS_TEST_RECIPIENT: 'junk' })).toEqual({ mode: 'invalid-test', value: 'junk' });
    expect(fundAlertTarget({ FUND_ALERTS_TEST_RECIPIENT: 'ops@bajaj.test' })).toEqual({ mode: 'invalid-test', value: 'ops@bajaj.test' });
    expect(fundAlertTarget({ FUND_ALERTS_TEST_RECIPIENT: 'qa@corp.example', REPORTS_RECIPIENT_DOMAINS: 'corp.example' })).toEqual({ mode: 'test', to: 'qa@corp.example' });
    expect(fundAlertTarget({ FUND_ALERTS_LIVE: 'true', FUND_ALERTS_TEST_RECIPIENT: 'qa@gifsy.in' })).toEqual({ mode: 'live' });
  });

  it('no fund set-up → no line, no statement compute', async () => {
    const { svc, prisma } = makeService();
    expect(await svc.digestAndAlert('bajaj', Date.now())).toEqual({ figures: null });
    expect(prisma.redemptionOrder.findMany).not.toHaveBeenCalled();
  });

  it('LIVE: low + not yet sent today → ONE e-mail to the client recipients, from ONE statement compute; count recorded', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const { svc, prisma, mail } = lowClient();
    const r = await svc.digestAndAlert('bajaj', Date.now());
    expect(r.figures).toMatchObject({ isLow: true, hasOpening: true });
    expect(r.alert).toMatchObject({ status: 'sent', recipients: 1 });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail.mock.calls[0][0].to).toEqual(['ops@bajaj.test']);
    expect(mail.sendEmail.mock.calls[0][0].subject).toContain('Bajaj Consumer');
    expect(prisma.redemptionOrder.findMany).toHaveBeenCalledTimes(1); // single compute
    expect(prisma.fundSettings.updateMany.mock.calls[0][0].data).toEqual({ lowAlertLastSentOn: today() });
    expect(prisma.fundSettings.update).toHaveBeenCalledWith({ where: { clientId: 'bajaj' }, data: { lowAlertLastError: null, lowAlertLastRecipients: 1 } });
  });

  it('B5 staging: only the TEST address gets it (subject names the real recipients); unset → nothing sent', async () => {
    process.env.FUND_ALERTS_TEST_RECIPIENT = 'qa@gifsy.in';
    delete process.env.FUND_ALERTS_LIVE;
    const a = lowClient();
    expect((await a.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('sent-to-test-address');
    expect(a.mail.sendEmail.mock.calls[0][0].to).toEqual(['qa@gifsy.in']);
    expect(a.mail.sendEmail.mock.calls[0][0].subject).toContain('[TEST — would go to 1 recipient(s): ops@bajaj.test]');
    delete process.env.FUND_ALERTS_TEST_RECIPIENT;
    const b = lowClient();
    expect((await b.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('disabled-in-environment');
    expect(b.mail.sendEmail).not.toHaveBeenCalled();
  });

  it('A7: no opening balance → no e-mail ("no-opening"); a non-ACTIVE client → none ("client-inactive")', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const a = lowClient({ opening: false });
    expect((await a.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('no-opening');
    const b = lowClient();
    b.prisma.client.findUnique.mockResolvedValue({ status: 'INACTIVE', internalName: 'Bajaj', branding: {} });
    expect((await b.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('client-inactive');
    expect(a.mail.sendEmail).not.toHaveBeenCalled();
    expect(b.mail.sendEmail).not.toHaveBeenCalled();
  });

  it('already sent today, or a lost claim race → no e-mail', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const a = lowClient({ settings: { lowAlertLastSentOn: today() } });
    expect((await a.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('already-sent-today');
    const b = lowClient();
    b.prisma.fundSettings.updateMany.mockResolvedValue({ count: 0 });
    expect((await b.svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('already-sent-today');
    expect(a.mail.sendEmail).not.toHaveBeenCalled();
    expect(b.mail.sendEmail).not.toHaveBeenCalled();
  });

  it('B6: a relay rejection or a send failure releases today\'s claim (a forced re-run retries) and is stored', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const a = lowClient({ settings: { lowAlertLastSentOn: '2000-01-01' } });
    a.mail.sendEmail.mockResolvedValue({ skipped: false, accepted: [], rejected: ['ops@bajaj.test'] });
    const ra = await a.svc.digestAndAlert('bajaj', Date.now());
    expect(ra.alert).toMatchObject({ status: 'failed' });
    expect(a.prisma.fundSettings.update).toHaveBeenCalledWith({ where: { clientId: 'bajaj' }, data: { lowAlertLastSentOn: '2000-01-01', lowAlertLastError: expect.stringContaining('rejected ops@bajaj.test') } });
    const b = lowClient();
    b.mail.sendEmail.mockRejectedValue(new Error('SMTP down'));
    const rb = await b.svc.digestAndAlert('bajaj', Date.now());
    expect(rb.alert!.error).toContain('SMTP down');
    expect(b.prisma.fundSettings.update).toHaveBeenCalledWith({ where: { clientId: 'bajaj' }, data: { lowAlertLastSentOn: null, lowAlertLastError: expect.stringContaining('SMTP down') } });
  });

  it('B4: a non-internal FUND_ALERTS_TEST_RECIPIENT is refused loudly — nothing sent', async () => {
    delete process.env.FUND_ALERTS_LIVE;
    process.env.FUND_ALERTS_TEST_RECIPIENT = 'someone@client.example';
    const { svc, mail } = lowClient();
    const r = await svc.digestAndAlert('bajaj', Date.now());
    expect(r.alert).toMatchObject({ status: 'test-recipient-not-internal' });
    expect(r.alert!.error).toContain('not on an internal domain');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('B4: the client view says plainly when alert e-mails are switched off on this server', async () => {
    delete process.env.FUND_ALERTS_LIVE;
    delete process.env.FUND_ALERTS_TEST_RECIPIENT;
    const off = await makeService().svc.summary(clientAdmin);
    expect(off.lowBalance.emailsSwitchedOff).toBe(true);
    process.env.FUND_ALERTS_LIVE = 'true';
    expect((await makeService().svc.summary(clientAdmin)).lowBalance.emailsSwitchedOff).toBe(false);
  });

  it('B2: the low-balance step runs on its own — every client with a threshold is checked and the outcome recorded; one failure never stops the rest', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const { svc, prisma } = lowClient();
    prisma.fundSettings.findMany.mockResolvedValue([{ clientId: 'bajaj' }, { clientId: 'deoleo' }]);
    const spy = jest.spyOn(svc, 'digestAndAlert').mockImplementation(async (c: string) => {
      if (c === 'deoleo') throw new Error('db timeout');
      return { figures: null, alert: { clientId: c, status: 'not-low' } };
    });
    const out = await svc.runLowBalanceAlerts(Date.now());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.results.get('bajaj')!.alert!.status).toBe('not-low');
    expect(out.results.get('deoleo')!.alert).toMatchObject({ status: 'failed', error: 'db timeout' });
    const recorded = prisma.fundSettings.update.mock.calls.map(([a]) => [(a as { where: { clientId: string } }).where.clientId, (a as { data: { lowAlertLastStatus: string } }).data.lowAlertLastStatus]);
    expect(recorded).toEqual([['bajaj', 'not-low'], ['deoleo', 'failed']]);
    expect(prisma.fundSettings.findMany.mock.calls[0][0].where).toMatchObject({ lowBalanceThresholdPaise: { not: null }, clientId: { not: 'gifsy' } });
  });

  it('round 4 item 6: the step has its own time budget — clients after it are recorded "not checked", never skipped silently', async () => {
    const { svc, prisma } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([{ clientId: 'bajaj' }, { clientId: 'deoleo' }]);
    const spy = jest.spyOn(svc, 'digestAndAlert').mockResolvedValue({ figures: null, alert: { clientId: 'bajaj', status: 'not-low' } });
    let t = 0;
    const clock = () => (t += 40_000); // each tick 40 s: the first client fits the 60 s budget, the second does not
    const out = await svc.runLowBalanceAlerts(Date.now(), 60_000, clock);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.results.get('deoleo')!.alert!.status).toBe('not-checked-time-budget');
    const recorded = prisma.fundSettings.update.mock.calls.map(([a]) => (a as { data: { lowAlertLastStatus: string } }).data.lowAlertLastStatus);
    expect(recorded).toEqual(['not-low', 'not-checked-time-budget']);
  });

  it('round 5 N5: a client whose check outlasts the remaining budget is "not checked — time budget" (raced, never awaited forever)', async () => {
    const { svc, prisma } = makeService();
    prisma.fundSettings.findMany.mockResolvedValue([{ clientId: 'bajaj' }]);
    jest.spyOn(svc, 'digestAndAlert').mockImplementation(() => new Promise(() => undefined)); // never settles
    const out = await svc.runLowBalanceAlerts(Date.now(), 30);
    expect(out.results.get('bajaj')!.alert!.status).toBe('not-checked-time-budget');
    expect(prisma.fundSettings.update.mock.calls[0][0].data.lowAlertLastStatus).toBe('not-checked-time-budget');
  });

  it('round 5 N5: past the deadline, digestAndAlert never sends (a late computation cannot e-mail)', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const { svc, mail } = lowClient();
    const r = await svc.digestAndAlert('bajaj', Date.now(), { deadlineMs: 0, clock: () => 1 });
    expect(r.alert!.status).toBe('not-checked-time-budget');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('B2: an unreadable settings table is reported (error), never thrown', async () => {
    const { svc, prisma } = makeService();
    prisma.fundSettings.findMany.mockRejectedValue(new Error('conn reset'));
    const out = await svc.runLowBalanceAlerts(Date.now());
    expect(out.error).toContain('conn reset');
    expect(out.results.size).toBe(0);
  });

  it('digest-only call (send:false) computes figures and never e-mails', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const { svc, mail } = lowClient();
    const r = await svc.digestAndAlert('bajaj', Date.now(), { send: false });
    expect(r.figures).toMatchObject({ isLow: true });
    expect(r.alert).toBeUndefined();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('e-mail not configured → not sent, error recorded (never reported as delivered)', async () => {
    process.env.FUND_ALERTS_LIVE = 'true';
    const { svc, mail } = lowClient();
    mail.isEmailConfigured.mockReturnValue(false);
    expect((await svc.digestAndAlert('bajaj', Date.now())).alert!.status).toBe('email-not-configured');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
});
