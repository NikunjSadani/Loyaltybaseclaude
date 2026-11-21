/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HeldOpeningBalancesService } from './held-opening-balances.service';
import { heldDigestFigures } from './held-balance-facts';
import { blankWallet, emptyDb, fakePrisma, HeldDb, heldRow, SAMPLE_EVENTS } from './held-harness.test-spec';

const GIFSY = { sub: 'gadmin', clientId: 'bajaj', role: 'GIFSY_ADMIN', assumed: true };

function seed(db: HeldDb) {
  db.partners.push({ id: 'cp1', clientId: 'bajaj' }, { id: 'cp2', clientId: 'bajaj' }, { id: 'cpD', clientId: 'deoleo' });
  db.outlets.push(
    { id: 'o1', clientId: 'bajaj', outletCode: '50100001', partnerId: 'cp1', name: 'Shree Stores', deletedAt: null },
    { id: 'o2', clientId: 'bajaj', outletCode: '50100002', partnerId: 'cp2', name: 'Busy Traders', deletedAt: null },
    { id: 'oD', clientId: 'deoleo', outletCode: '50100009', partnerId: 'cpD', name: 'Deoleo shop', deletedAt: null },
  );
  db.wallets.push(blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2', { redeemablePoints: 40, earnedPoints: 40, lifetimeEarned: 40 }));
  db.walletTxns.push({ id: 'old', walletId: 'w2', transactionType: 'CREDIT_POINTS_EARNED', points: 40, balanceBefore: 0, balanceAfter: 40, balanceType: 'REDEEMABLE', seq: null, createdAt: new Date() });
  db.users.push({ id: 'gadmin', role: 'GIFSY_ADMIN', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null });
  const pristine = heldRow({ outletCode: '50100001', closingPoints: 600, events: SAMPLE_EVENTS });
  const active = heldRow({ outletCode: '50100002', closingPoints: 600, events: SAMPLE_EVENTS });
  const notOnPortal = heldRow({ outletCode: '59999999', closingPoints: 75, events: [{ d: '2025-04-01', t: 'EARN', p: 75, l: 'Points earned' }] });
  const otherTenant = heldRow({ clientId: 'deoleo', outletCode: '50100009', closingPoints: 5, events: [{ d: '2025-04-01', t: 'EARN', p: 5, l: 'Points earned' }] });
  db.held.push(pristine, active, notOnPortal, otherTenant);
  return { pristine, active, notOnPortal, otherTenant };
}

function build(db: HeldDb, adj?: (tx: any, partnerId: string, points: number) => Promise<any>) {
  const prisma = fakePrisma(db);
  const wallet = {
    resolveEngineAdminTenant: async (actor: any, explicit?: string | null) => {
      if (actor.assumed) {
        if (explicit && explicit !== actor.clientId) throw new BadRequestException('wrong program');
        return actor.clientId;
      }
      if (!explicit) throw new BadRequestException('Choose the program');
      return explicit;
    },
    postHeldOpeningAdjustment: jest.fn(
      adj ??
        (async (tx: any, partnerId: string, points: number) => {
          const w = db.wallets.find((x) => x.partnerId === partnerId)!;
          const before = w.redeemablePoints;
          w.redeemablePoints += points;
          w.earnedPoints += points;
          const t = await tx.walletTransaction.create({ data: { walletId: w.id, transactionType: 'CREDIT_ADJUSTMENT', points, balanceBefore: before, balanceAfter: w.redeemablePoints, balanceType: 'REDEEMABLE' } });
          return { transactionId: t.id, newRedeemable: w.redeemablePoints, ledgerId: 'pl' };
        }),
    ),
  };
  const tenantSettings = { getReversalEngineModeUncached: async () => 'LEGACY' };
  return { svc: new HeldOpeningBalancesService(prisma as any, wallet as any, tenantSettings as any), wallet, prisma };
}

describe('HeldOpeningBalancesService — Gifsy console', () => {
  it('list: rows + outlet/wallet facts + per-status totals, own tenant only', async () => {
    const db = emptyDb();
    seed(db);
    const { svc } = build(db);
    const r = await svc.list(GIFSY, {});
    expect(r.total).toBe(3);
    expect(r.totals.PENDING).toEqual({ count: 3, points: 1275 });
    const by = Object.fromEntries(r.rows.map((x) => [x.outletCode, x]));
    expect(by['50100001']).toEqual(expect.objectContaining({ outletName: 'Shree Stores', outletExists: true, hasWallet: true, walletHasActivity: false, eventCount: 4 }));
    expect(by['50100002']).toEqual(expect.objectContaining({ hasWallet: true, walletHasActivity: true }));
    expect(by['59999999']).toEqual(expect.objectContaining({ outletName: null, outletExists: false, hasWallet: false }));
    expect(by['50100009']).toBeUndefined();
    expect((await svc.list(GIFSY, { q: '5999' })).rows.map((x) => x.outletCode)).toEqual(['59999999']);
    await expect(svc.list(GIFSY, { status: 'BOGUS' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tenant isolation: another tenant\'s row is a 404 on preview / apply / cancel, and an un-assumed session must name the program', async () => {
    const db = emptyDb();
    const { otherTenant } = seed(db);
    const { svc } = build(db);
    await expect(svc.preview(GIFSY, otherTenant.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.applyNow(GIFSY, otherTenant.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel(GIFSY, otherTenant.id, null, 'x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.list({ ...GIFSY, assumed: false }, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(db.held.find((h) => h.id === otherTenant.id)!.status).toBe('PENDING');
  });

  it('preview: FULL_PASSBOOK on an empty wallet, OPENING_ADJUSTMENT (before → after) on an active one, blocked without a wallet', async () => {
    const db = emptyDb();
    const { pristine, active, notOnPortal } = seed(db);
    const { svc } = build(db);
    expect(await svc.preview(GIFSY, pristine.id)).toEqual(expect.objectContaining({ canApply: true, mode: 'FULL_PASSBOOK', balanceBefore: 0, balanceAfter: 600 }));
    expect(await svc.preview(GIFSY, active.id)).toEqual(expect.objectContaining({ canApply: true, mode: 'OPENING_ADJUSTMENT', balanceBefore: 40, balanceAfter: 640 }));
    const nope = await svc.preview(GIFSY, notOnPortal.id);
    expect(nope.canApply).toBe(false);
    expect(nope.blockedReason).toMatch(/not on the portal yet/);
  });

  it('Apply now on an empty wallet posts the full dated passbook (audited)', async () => {
    const db = emptyDb();
    const { pristine } = seed(db);
    const { svc, wallet } = build(db);
    const r = await svc.applyNow(GIFSY, pristine.id, null, 'approved before rows were loaded');
    expect(r).toEqual(expect.objectContaining({ status: 'APPLIED', balanceBefore: 0, balanceAfter: 600, failureReason: null }));
    expect(db.walletTxns.filter((t) => t.walletId === 'w1')).toHaveLength(4);
    expect(db.held.find((h) => h.id === pristine.id)!.appliedBy).toBe('gadmin');
    expect(wallet.postHeldOpeningAdjustment).not.toHaveBeenCalled();
    expect(db.audits.some((a) => a.metadata?.applyNowReason === 'approved before rows were loaded')).toBe(true);
  });

  it('Apply now on a wallet WITH activity posts ONE opening adjustment through the engine and verifies the balance moved by exactly the closing', async () => {
    const db = emptyDb();
    const { active } = seed(db);
    const { svc, wallet } = build(db);
    const r = await svc.applyNow(GIFSY, active.id);
    expect(r).toEqual(expect.objectContaining({ status: 'APPLIED', balanceBefore: 40, balanceAfter: 640 }));
    expect(wallet.postHeldOpeningAdjustment).toHaveBeenCalledWith(expect.anything(), 'cp2', 600, expect.objectContaining({ sourceId: `50100002:held-open:${active.id}` }));
    const h = db.held.find((x) => x.id === active.id)!;
    expect([h.status, h.applyMode, h.appliedWalletId]).toEqual(['APPLIED', 'OPENING_ADJUSTMENT', 'w2']);
    expect(db.audits.find((a) => a.entityId === active.id && a.newValues?.status === 'APPLIED')).toEqual(
      expect.objectContaining({ actorId: 'gadmin', oldValues: { status: 'PENDING', balance: 40 } }),
    );
    // idempotent: a second Apply now is refused, nothing double-posted
    await expect(svc.applyNow(GIFSY, active.id)).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.postHeldOpeningAdjustment).toHaveBeenCalledTimes(1);
  });

  it('an adjustment that does not move the balance by exactly the closing is rolled back and FAILED (never partial)', async () => {
    const db = emptyDb();
    const { active } = seed(db);
    const { svc } = build(db, async (tx: any, partnerId: string, points: number) => {
      const w = db.wallets.find((x) => x.partnerId === partnerId)!;
      w.redeemablePoints += points - 100; // e.g. debt absorbed part of it
      await tx.walletTransaction.create({ data: { walletId: w.id, transactionType: 'CREDIT_ADJUSTMENT', points, balanceBefore: 40, balanceAfter: w.redeemablePoints, balanceType: 'REDEEMABLE' } });
      return { transactionId: 't', newRedeemable: w.redeemablePoints, ledgerId: 'pl' };
    });
    const r = await svc.applyNow(GIFSY, active.id);
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toMatch(/rolled back — the balance moved from 40 to 540 pts, expected 640/);
    expect(db.wallets.find((w) => w.id === 'w2')!.redeemablePoints).toBe(40);
    expect(db.walletTxns.filter((t) => t.walletId === 'w2')).toHaveLength(1);
    expect(db.bells).toHaveLength(1);
  });

  it('a FAILED row can be fixed by Apply now (retry) once the cause is gone', async () => {
    const db = emptyDb();
    const { pristine } = seed(db);
    Object.assign(db.held.find((h) => h.id === pristine.id)!, { status: 'FAILED', failureReason: 'earlier problem' });
    const { svc } = build(db);
    const r = await svc.applyNow(GIFSY, pristine.id);
    expect(r.status).toBe('APPLIED');
    expect(db.held.find((h) => h.id === pristine.id)!.failureReason).toBeNull();
  });

  it('Apply now without a wallet is refused (it waits for KYC approval) — nothing changed', async () => {
    const db = emptyDb();
    const { notOnPortal } = seed(db);
    const { svc } = build(db);
    await expect(svc.applyNow(GIFSY, notOnPortal.id)).rejects.toBeInstanceOf(ConflictException);
    expect(db.held.find((h) => h.id === notOnPortal.id)!.status).toBe('PENDING');
  });

  it('cancel: reason required, audited, only PENDING / FAILED', async () => {
    const db = emptyDb();
    const { notOnPortal, pristine } = seed(db);
    const { svc } = build(db);
    await expect(svc.cancel(GIFSY, notOnPortal.id, null, '  ')).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.cancel(GIFSY, notOnPortal.id, null, 'outlet closed — client confirmed');
    expect(r).toEqual(expect.objectContaining({ status: 'CANCELLED', cancelReason: 'outlet closed — client confirmed', cancelledBy: 'gadmin' }));
    expect(db.audits.find((a) => a.entityId === notOnPortal.id)).toEqual(expect.objectContaining({ newValues: { status: 'CANCELLED', cancelReason: 'outlet closed — client confirmed' } }));
    await svc.applyNow(GIFSY, pristine.id);
    await expect(svc.cancel(GIFSY, pristine.id, null, 'too late')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('heldDigestFigures — the Daily Ops Digest line', () => {
  it('null (section hidden) for a tenant without rows; counts applied-in-window / waiting / needs Apply now / failed otherwise', async () => {
    const db = emptyDb();
    const { pristine } = seed(db);
    const prisma = fakePrisma(db) as any;
    expect(await heldDigestFigures(prisma, 'tata', { startMs: 0, endMs: Date.now() + 1 })).toBeNull();
    const now = Date.now();
    Object.assign(db.held.find((h) => h.id === pristine.id)!, { status: 'APPLIED', appliedAt: new Date(now - 1000) });
    db.held.push(heldRow({ outletCode: '50100003', closingPoints: 9, status: 'FAILED', events: [] }));
    expect(await heldDigestFigures(prisma, 'bajaj', { startMs: now - 3600_000, endMs: now })).toEqual({
      totalRows: 4,
      appliedInWindow: 1,
      appliedInWindowPoints: 600,
      waiting: 2,
      waitingPoints: 675,
      waitingNeedsApplyNow: 1,
      failed: 1,
      failedPoints: 9,
    });
  });
});
