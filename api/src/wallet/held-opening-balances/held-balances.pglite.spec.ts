/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HELD OPENING BALANCES on a REAL Postgres (PGlite over the wire protocol) with the REAL PrismaClient, WalletService
 * and WP6 backfill planner: transactions, rollbacks, row locks, the one-live-row-per-outlet partial unique index,
 * sequencing, the loader store. Every test starts from an empty set of business rows (truncate between tests).
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { migrationSql, startPglitePrisma, type PglitePrisma } from '../../common/testing/pglite-prisma-testkit-spec';
import { WalletService } from '../wallet.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { HeldOpeningBalancesService } from './held-opening-balances.service';
import { applyHeldRow, HELD_MAX_ATTEMPTS, prepareHeldBeforeCredit, runHeldForPartner, sweepHeldOpeningBalances } from './held-balance-apply';
import { heldDigestFigures } from './held-balance-facts';
import { PrismaHeldLoadStore, runHeldLoad } from './held-balances-load';
import { SAMPLE_EVENTS } from './held-fixtures.test-spec';

jest.setTimeout(240_000);

let db: PglitePrisma;
let prisma: PrismaClient;
let wallet: WalletService;
let svc: HeldOpeningBalancesService;
const GIFSY = { sub: 'gadmin', clientId: 'bajaj', role: 'GIFSY_ADMIN', assumed: true };

beforeAll(async () => {
  db = await startPglitePrisma([migrationSql('20261121100000_held_opening_balances')]);
  prisma = db.prisma;
  wallet = new WalletService(prisma as any, new TenantSettingsService(prisma as any));
  svc = new HeldOpeningBalancesService(prisma as any, wallet);
});
afterAll(async () => db?.close());

const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

beforeEach(async () => {
  await q(`DROP TRIGGER IF EXISTS held_fail ON points_ledger`);
  await q(`TRUNCATE held_opening_balances, wallet_credit_positions, wallet_transactions, points_ledger, wallets, outlets,
           channel_partners, outlet_types, notification_queue, audit_logs, program_settings, users, clients CASCADE`);
  for (const c of ['bajaj', 'deoleo', 'gifsy']) {
    await q(`INSERT INTO clients (id,"internalName",status,"onboardedAt",branding,features,"approvalHierarchy",notifications,invoicing,wallet,"updatedAt")
             VALUES ($1,$1,'ACTIVE',now(),'{}','{}','{}','{}','{}','{}',now())`, [c]);
  }
  await q(`INSERT INTO users (id,"clientId",phone,name,role,status,"updatedAt") VALUES ('gadmin','gifsy','9000000001','Admin','GIFSY_ADMIN','ACTIVE',now())`);
  await q(`INSERT INTO outlet_types (id,code,name,"updatedAt") VALUES ('ot1','WHOLESALER','Wholesaler',now())`);
});

async function partner(id: string, clientId = 'bajaj', outletCodes: string[] = [], withWallet = false) {
  await q(`INSERT INTO channel_partners (id,"clientId","partnerCode","businessName","ownerName","updatedAt") VALUES ($1,$2,$1,$1,'Owner',now())`, [id, clientId]);
  for (const code of outletCodes) {
    await q(`INSERT INTO outlets (id,"clientId","outletTypeId","outletCode",name,city,state,"partnerId","updatedAt") VALUES ($1,$2,'ot1',$3,$4,'Pune','MH',$5,now())`, [`o_${code}_${clientId}`, clientId, code, `Shop ${code}`, id]);
  }
  if (withWallet) await q(`INSERT INTO wallets (id,"partnerId","updatedAt") VALUES ($1,$2,now())`, [`w_${id}`, id]);
}
async function held(outletCode: string, extra: Record<string, unknown> = {}) {
  return prisma.heldOpeningBalance.create({
    data: {
      clientId: 'bajaj', outletCode, source: 'vendor-earnburn-2026-11-11', asOfDate: new Date('2026-11-11T00:00:00Z'),
      closingPoints: 600, events: SAMPLE_EVENTS as any, ...extra,
    } as any,
  });
}
const v2 = (clientId = 'bajaj') =>
  q(`INSERT INTO program_settings (id,"clientId","settingKey","settingValue","updatedAt") VALUES ($1,$2,'reversalEngine','"V2"',now())`, [`ps_${clientId}`, clientId]);
const w = (id: string) => prisma.wallet.findUniqueOrThrow({ where: { id } });

describe('auto apply (post-commit KYC / sweep) — real Postgres', () => {
  it('posts the dated passbook in its own transaction and SEQUENCES the wallet for V2 (backfillStatus DONE)', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    const h = await held('50100001');
    const out = await runHeldForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger: 'KYC_APPROVAL', actorId: 'gadmin' });
    expect(out).toEqual([expect.objectContaining({ status: 'APPLIED', applyMode: 'FULL_PASSBOOK', sequencing: 'SEQUENCED', balanceAfter: 600 })]);
    const wl = await w('w_cp1');
    expect([wl.redeemablePoints, wl.earnedPoints, wl.redeemedPoints, wl.expiredPoints, wl.movementSeq, wl.debtPoints, wl.backfillStatus]).toEqual([600, 900, 200, 100, 4, 0, 'DONE']);
    const txs = await prisma.walletTransaction.findMany({ where: { walletId: 'w_cp1' }, orderBy: { seq: 'asc' } });
    expect(txs.map((t) => [t.seq, t.pointsDelta, t.balanceAfter, t.description])).toEqual([
      [1, 500, 500, 'Points earned'], [2, 400, 900, 'Points earned — SPL4 Scratch Payout'], [3, -200, 700, 'Points redeemed'], [4, -100, 600, 'Points expired'],
    ]);
    expect(txs.every((t) => t.pointsLedgerId)).toBe(true);
    const lots = await prisma.pointsLedger.findMany({ where: { walletId: 'w_cp1' }, orderBy: { createdAt: 'asc' } });
    expect(lots.map((l) => [l.remainingPoints, l.expiresAt, l.sourceType])).toEqual([[200, null, 'VENDOR_IMPORT'], [400, null, 'VENDOR_IMPORT'], [0, null, 'VENDOR_IMPORT'], [0, null, 'VENDOR_IMPORT']]);
    const row = await prisma.heldOpeningBalance.findUniqueOrThrow({ where: { id: h.id } });
    expect([row.status, row.appliedWalletId, row.appliedBy]).toEqual(['APPLIED', 'w_cp1', 'KYC_APPROVAL']);
    // idempotent: re-running never double-posts
    expect(await runHeldForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger: 'SWEEP' })).toEqual([]);
    expect(await prisma.walletTransaction.count({ where: { walletId: 'w_cp1' } })).toBe(4);
  });

  it('a DB error mid-posting rolls the WHOLE transaction back (nothing partial), keeps the row PENDING for retry, then FAILED after the attempt cap', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    const h = await held('50100001');
    await q(`CREATE OR REPLACE FUNCTION held_fail_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full (test)'; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER held_fail BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION held_fail_fn()`);
    const first = await applyHeldRow(prisma, h.id, { trigger: 'SWEEP', allowedFrom: ['PENDING'] });
    expect(first.status).toBe('RETRYING');
    expect(await prisma.walletTransaction.count()).toBe(0); // the wallet_transactions insert before the failure is gone
    expect((await w('w_cp1')).redeemablePoints).toBe(0);
    let row = await prisma.heldOpeningBalance.findUniqueOrThrow({ where: { id: h.id } });
    expect([row.status, row.attempts]).toEqual(['PENDING', 1]);
    expect(row.lastError).toMatch(/disk full/);
    for (let i = 1; i < HELD_MAX_ATTEMPTS; i++) await applyHeldRow(prisma, h.id, { trigger: 'SWEEP', allowedFrom: ['PENDING'] });
    row = await prisma.heldOpeningBalance.findUniqueOrThrow({ where: { id: h.id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/gave up after 5 attempts — last error: .*disk full/);
    expect(await prisma.notificationQueue.count({ where: { userId: 'gadmin', channel: 'IN_APP' } })).toBe(1);
  });

  it('closing ≠ Σ events → FAILED immediately with the reason, nothing posted, bell to the Gifsy admin', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    const h = await held('50100001', { closingPoints: 601 });
    const r = await applyHeldRow(prisma, h.id, { trigger: 'KYC_APPROVAL', allowedFrom: ['PENDING'] });
    expect(r.status).toBe('FAILED');
    expect(r.reason).toMatch(/adds up to 600 pts but the closing balance is 601/);
    expect(await prisma.walletTransaction.count()).toBe(0);
    expect(await prisma.notificationQueue.count()).toBe(1);
  });

  it('a wallet with activity is never touched automatically; no wallet → nothing written', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await partner('cp2', 'bajaj', ['50100002'], false);
    await wallet.creditEarn('cp1', 'bajaj', 40, {});
    await held('50100001');
    await held('50100002');
    const a = await runHeldForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger: 'KYC_APPROVAL' });
    const b = await runHeldForPartner(prisma, { partnerId: 'cp2', clientId: 'bajaj', trigger: 'KYC_APPROVAL' });
    expect(a[0].status).toBe('NEEDS_APPLY_NOW');
    expect(b[0].status).toBe('NO_WALLET');
    expect((await w('w_cp1')).redeemablePoints).toBe(40);
    expect(await prisma.heldOpeningBalance.count({ where: { status: 'PENDING' } })).toBe(2);
  });

  it('the sweep applies a row whose wallet exists and is EMPTY (never left waiting)', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await partner('cp2', 'bajaj', ['50100002'], false);
    await held('50100001');
    await held('50100002');
    const out = await sweepHeldOpeningBalances(prisma);
    expect(out.map((o) => [o.outletCode, o.status])).toEqual([['50100001', 'APPLIED']]);
  });

  it('outlet codes match after normalising (trim / upper-case / internal spaces) — leading zeros are NOT stripped', async () => {
    await partner('cp1', 'bajaj', [' bj 0012 '], true);
    await partner('cp2', 'bajaj', ['12'], true);
    await held('BJ0012');
    await held('0012');
    const out = await sweepHeldOpeningBalances(prisma);
    expect(out.map((o) => [o.outletCode, o.status])).toEqual([['BJ0012', 'APPLIED']]);
    expect((await w('w_cp2')).redeemablePoints).toBe(0);
  });

  it('tenant isolation: a held row of another tenant is never applied to this tenant\'s outlet', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await prisma.heldOpeningBalance.create({ data: { clientId: 'deoleo', outletCode: '50100001', source: 's', closingPoints: 600, events: SAMPLE_EVENTS as any } });
    expect(await runHeldForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger: 'KYC_APPROVAL' })).toEqual([]);
    expect(await sweepHeldOpeningBalances(prisma)).toEqual([]);
    expect((await w('w_cp1')).redeemablePoints).toBe(0);
  });
});

describe('never twice — database + apply guards (real Postgres)', () => {
  it('the partial unique index allows ONE live (PENDING/FAILED/APPLIED) row per outlet; CANCELLED rows do not count', async () => {
    const a = await held('50100001');
    await expect(held('50100001', { source: 'vendor-reload' })).rejects.toThrow(/Unique constraint/i);
    await prisma.heldOpeningBalance.update({ where: { id: a.id }, data: { status: 'APPLIED' } });
    await expect(held('50100001', { source: 'vendor-reload' })).rejects.toThrow(/Unique constraint/i);
    await prisma.heldOpeningBalance.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
    await expect(held('50100001', { source: 'vendor-reload' })).resolves.toBeTruthy();
  });

  it('Apply now refuses a wallet that already received a held balance via another outlet of the same owner', async () => {
    await partner('cp1', 'bajaj', ['50100001', '50100002'], true);
    const a = await held('50100001');
    expect((await applyHeldRow(prisma, a.id, { trigger: 'SWEEP', allowedFrom: ['PENDING'] })).status).toBe('APPLIED');
    const b = await held('50100002', { closingPoints: 10, events: [{ d: '2025-04-01', t: 'EARN', p: 10, l: 'Points earned' }] });
    const r = await svc.applyNow(GIFSY, b.id);
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toMatch(/already received a held opening balance \(50100001/);
    expect((await w('w_cp1')).redeemablePoints).toBe(600);
  });

  it('two live rows for one owner (would pool) → both FAILED, nothing posted', async () => {
    await partner('cp1', 'bajaj', ['50100001', '50100002'], true);
    await held('50100001');
    await held('50100002', { closingPoints: 10, events: [{ d: '2025-04-01', t: 'EARN', p: 10, l: 'Points earned' }] });
    const out = await runHeldForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger: 'KYC_APPROVAL' });
    expect(out.map((o) => o.status)).toEqual(['FAILED', 'FAILED']);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});

describe('Apply now (console) — real WalletService', () => {
  it('a sequenced wallet with activity gets ONE opening-balance adjustment, plain retailer wording with the as-of date', async () => {
    await v2();
    await partner('cp1', 'bajaj', ['50100001'], true);
    await wallet.creditEarn('cp1', 'bajaj', 40, {}); // pristine wallet on V2 → V2-tracked (seq 1)
    expect((await w('w_cp1')).movementSeq).toBe(1);
    const h = await held('50100001');
    expect(await svc.preview(GIFSY, h.id)).toEqual(expect.objectContaining({ canApply: true, mode: 'OPENING_ADJUSTMENT', balanceBefore: 40, balanceAfter: 640 }));
    const r = await svc.applyNow(GIFSY, h.id, null, 'approved before rows were loaded');
    expect(r).toEqual(expect.objectContaining({ status: 'APPLIED', applyMode: 'OPENING_ADJUSTMENT', balanceBefore: 40, balanceAfter: 640 }));
    const last = await prisma.walletTransaction.findFirstOrThrow({ where: { walletId: 'w_cp1' }, orderBy: { seq: 'desc' } });
    expect([last.seq, last.points, last.description]).toEqual([2, 600, 'Opening balance from previous programme (as of 11 Nov 2026)']);
    expect(last.description).not.toMatch(/vendor-earnburn/);
    await expect(svc.applyNow(GIFSY, h.id)).rejects.toBeInstanceOf(ConflictException);
    expect((await w('w_cp1')).redeemablePoints).toBe(640);
  });

  it('V2-only: an active wallet that is NOT sequenced → FAILED with the reason, rolled back (never applied-but-unsequenced)', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await wallet.creditEarn('cp1', 'bajaj', 40, {}); // LEGACY tenant → un-sequenced history
    const h = await held('50100001');
    expect((await svc.preview(GIFSY, h.id)).blockedReason).toMatch(/not sequenced/);
    const r = await svc.applyNow(GIFSY, h.id);
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toMatch(/not sequenced for the V2 engine/);
    expect((await w('w_cp1')).redeemablePoints).toBe(40);
    expect(await prisma.walletTransaction.count({ where: { walletId: 'w_cp1' } })).toBe(1);
  });

  it('list shows the explicit state of every row; tenant isolation on preview / apply / cancel; cancel needs a reason', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await partner('cp2', 'bajaj', ['50100002'], false);
    await partner('cp3', 'bajaj', ['50100003'], true);
    await wallet.creditEarn('cp3', 'bajaj', 5, {});
    await held('50100001');
    await held('50100002');
    await held('50100003');
    await held('59999999');
    const other = await prisma.heldOpeningBalance.create({ data: { clientId: 'deoleo', outletCode: '1', source: 's', closingPoints: 1, events: [] } });
    const r = await svc.list(GIFSY, {});
    expect(Object.fromEntries(r.rows.map((x) => [x.outletCode, x.state]))).toEqual({
      '50100001': 'WALLET_EMPTY', '50100002': 'AWAITING_KYC', '50100003': 'NEEDS_APPLY_NOW', '59999999': 'NOT_ON_PORTAL',
    });
    expect(r.rows.find((x) => x.outletCode === '59999999')!.stateLabel).toBe('Not on portal (no outlet with this code)');
    expect(r.pendingByState.WALLET_EMPTY).toEqual({ count: 1, points: 600 });
    await expect(svc.preview(GIFSY, other.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.applyNow(GIFSY, other.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel(GIFSY, other.id, null, 'x')).rejects.toBeInstanceOf(NotFoundException);
    const row = r.rows.find((x) => x.outletCode === '59999999')!;
    await expect(svc.cancel(GIFSY, row.id, null, ' ')).rejects.toBeInstanceOf(BadRequestException);
    expect((await svc.cancel(GIFSY, row.id, null, 'outlet closed')).status).toBe('CANCELLED');
    expect(await prisma.auditLog.count({ where: { entityId: row.id } })).toBe(1);
  });
});

describe('credit confirm ordering — the held passbook lands BEFORE the credit', () => {
  it('no wallet yet: the pre-step creates the wallet and applies the history first; the credit then sits on top (seq 5)', async () => {
    await v2();
    await partner('cp1', 'bajaj', ['50100001'], false);
    await held('50100001');
    const out = await prepareHeldBeforeCredit(prisma, {
      clientId: 'bajaj',
      outletCodes: ['50100001'],
      ensureWallet: async (pid) => { await prisma.wallet.upsert({ where: { partnerId: pid }, create: { id: `w_${pid}`, partnerId: pid }, update: {} }); },
    });
    expect(out[0].status).toBe('APPLIED');
    await wallet.creditEarn('cp1', 'bajaj', 50, { referenceType: 'MANUAL' });
    const txs = await prisma.walletTransaction.findMany({ where: { walletId: 'w_cp1' }, orderBy: { seq: 'asc' } });
    expect(txs.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(txs[4]).toEqual(expect.objectContaining({ points: 50, balanceBefore: 600, balanceAfter: 650 }));
  });

  it('dormant: a tenant without PENDING rows is one count and nothing else', async () => {
    await partner('cp1', 'bajaj', ['50100001'], false);
    expect(await prepareHeldBeforeCredit(prisma, { clientId: 'bajaj', outletCodes: ['50100001'], ensureWallet: async () => { throw new Error('must not run'); } })).toEqual([]);
  });
});

describe('loader store (real Postgres)', () => {
  const base = { expectedDb: 'postgres', clientId: 'bajaj', source: 'vendor-earnburn-2026-11-11', apply: true, confirm: 'APPLY postgres', asOf: '2026-11-11' };
  const one = (code: string, p: number) => ({ outletCode: code, closingPoints: p, events: [{ d: '2025-04-01', t: 'EARN', p, l: 'Points earned' }] });

  it('inserts normalised PENDING rows with the as-of date; a re-run is ALREADY_LOADED; a second live row is REFUSED (whole apply refused)', async () => {
    const store = new PrismaHeldLoadStore(prisma);
    const r1 = await runHeldLoad(store, { ...base, expectedRows: 2, expectedTotal: 610 }, [{ outletCode: ' 5010 0001 ', closingPoints: 600, events: SAMPLE_EVENTS }, one('X2', 10)], () => undefined);
    expect([r1.exitCode, r1.inserted]).toEqual([0, 2]);
    const row = await prisma.heldOpeningBalance.findFirstOrThrow({ where: { outletCode: '50100001' } });
    expect(row.asOfDate?.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    const r2 = await runHeldLoad(store, { ...base, expectedRows: 2, expectedTotal: 610 }, [{ outletCode: '50100001', closingPoints: 600, events: SAMPLE_EVENTS }, one('X2', 10)], () => undefined);
    expect([r2.exitCode, r2.counts.ALREADY_LOADED, r2.inserted]).toEqual([0, 2, 0]);
    const r3 = await runHeldLoad(store, { ...base, source: 'vendor-reload', expectedRows: 1, expectedTotal: 10 }, [one('X2', 10)], () => undefined);
    expect([r3.exitCode, r3.counts.REFUSED_EXISTING]).toEqual([3, 1]);
    expect(await prisma.heldOpeningBalance.count()).toBe(2);
  });

  it('SUPERSEDE cancels the old PENDING row and inserts the new one in ONE transaction; an APPLIED row is never superseded', async () => {
    const store = new PrismaHeldLoadStore(prisma);
    await runHeldLoad(store, { ...base, expectedRows: 1, expectedTotal: 10 }, [one('X2', 10)], () => undefined);
    const r = await runHeldLoad(store, { ...base, source: 'vendor-reload', supersede: true, expectedRows: 1, expectedTotal: 12 }, [one('X2', 12)], () => undefined);
    expect([r.exitCode, r.counts.SUPERSEDE, r.inserted]).toEqual([0, 1, 1]);
    expect((await prisma.heldOpeningBalance.findMany({ orderBy: { createdAt: 'asc' } })).map((x) => [x.source, x.status, x.closingPoints])).toEqual([
      ['vendor-earnburn-2026-11-11', 'CANCELLED', 10], ['vendor-reload', 'PENDING', 12],
    ]);
    await prisma.heldOpeningBalance.updateMany({ where: { source: 'vendor-reload' }, data: { status: 'APPLIED' } });
    const r2 = await runHeldLoad(store, { ...base, source: 'vendor-v3', supersede: true, expectedRows: 1, expectedTotal: 1 }, [one('X2', 1)], () => undefined);
    expect([r2.exitCode, r2.counts.REFUSED_EXISTING]).toEqual([3, 1]);
  });

  it('refuses an outlet whose wallet already carries a vendor balance (:tl: or :held-open: lots)', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await partner('cp2', 'bajaj', ['50100002'], true);
    await q(`INSERT INTO points_ledger (id,"walletId","transactionType",points,"sourceType","sourceId","updatedAt") VALUES ('pl1','w_cp1','EARN',5,'VENDOR_IMPORT','50100001:tl:1',now()), ('pl2','w_cp2','ADJUST',5,'VENDOR_IMPORT','50100002:held-open:abc',now())`);
    const r = await runHeldLoad(new PrismaHeldLoadStore(prisma), { ...base, expectedRows: 2, expectedTotal: 2 }, [one('50100001', 1), one('50100002', 1)], () => undefined);
    expect([r.exitCode, r.counts.REFUSED_IMPORTED]).toEqual([3, 2]);
    expect(await prisma.heldOpeningBalance.count()).toBe(0);
  });

  it('APPLY requires EXPECTED_ROWS + EXPECTED_TOTAL + AS_OF; Σ closing must equal Σ event deltas', async () => {
    const store = new PrismaHeldLoadStore(prisma);
    expect((await runHeldLoad(store, { ...base }, [one('A', 1)], () => undefined)).exitCode).toBe(2);
    expect((await runHeldLoad(store, { ...base, expectedRows: 1, expectedTotal: 1, asOf: undefined }, [one('A', 1)], () => undefined)).exitCode).toBe(2);
    const lying = [{ outletCode: 'A', closingPoints: 5, events: [{ d: '2025-04-01', t: 'EARN', p: 4, l: 'x' }] }];
    expect((await runHeldLoad(store, { ...base, expectedRows: 1, expectedTotal: 5 }, lying, () => undefined)).exitCode).toBe(3);
    expect(await prisma.heldOpeningBalance.count()).toBe(0);
  });
});

describe('digest figures (real Postgres)', () => {
  it('splits waiting rows by state; applied since the last report; null for a tenant without rows', async () => {
    await partner('cp1', 'bajaj', ['50100001'], true);
    await partner('cp2', 'bajaj', ['50100002'], false);
    await held('50100001');
    await held('50100002');
    await held('59999999');
    expect(await heldDigestFigures(prisma, 'deoleo', { startMs: 0, endMs: Date.now() })).toBeNull();
    const now = Date.now();
    const f = await heldDigestFigures(prisma, 'bajaj', { startMs: now - 3600_000, endMs: now + 3600_000, label: 'Fri 20 Nov, 09:30 → Sat 21 Nov, 09:30 IST' });
    expect(f).toEqual(expect.objectContaining({
      waiting: 3, waitingPoints: 1800, appliedInWindow: 0,
      waitingByState: { NOT_ON_PORTAL: 1, AWAITING_KYC: 1, WALLET_EMPTY: 1, NEEDS_APPLY_NOW: 0, AMBIGUOUS_OUTLET: 0 },
    }));
  });
});
