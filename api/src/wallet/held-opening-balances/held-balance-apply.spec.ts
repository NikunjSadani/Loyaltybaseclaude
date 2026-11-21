/* eslint-disable @typescript-eslint/no-explicit-any */
import { applyHeldOpeningBalancesForPartner, ReadEngineMode } from './held-balance-apply';
import { blankWallet, emptyDb, fakePrisma, HeldDb, heldRow, SAMPLE_EVENTS } from './held-harness.test-spec';
import { InvalidReversalEngineSettingException } from '../../tenant/tenant-settings.service';

const mode = (m: 'LEGACY' | 'SHADOW' | 'V2'): ReadEngineMode => async () => m;

function seed(db: HeldDb, extra: { closing?: number; events?: unknown[] } = {}) {
  db.partners.push({ id: 'cp1', clientId: 'bajaj' }, { id: 'cpD', clientId: 'deoleo' });
  db.outlets.push({ id: 'o1', clientId: 'bajaj', outletCode: '50100001', partnerId: 'cp1', name: 'Shree Stores', deletedAt: null });
  db.wallets.push(blankWallet('w1', 'cp1'));
  db.users.push(
    { id: 'gadmin', role: 'GIFSY_ADMIN', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null },
    { id: 'gadmin-off', role: 'GIFSY_ADMIN', clientId: 'gifsy', status: 'INACTIVE', deletedAt: null },
    { id: 'cadmin', role: 'CLIENT_ADMIN', clientId: 'bajaj', status: 'ACTIVE', deletedAt: null },
  );
  const row = heldRow({ outletCode: '50100001', closingPoints: extra.closing ?? 600, events: extra.events ?? SAMPLE_EVENTS });
  db.held.push(row);
  return row;
}

const run = (prisma: any, readMode: ReadEngineMode, trigger: 'KYC_APPROVAL' | 'CREDIT_CONFIRM' = 'KYC_APPROVAL') =>
  applyHeldOpeningBalancesForPartner(prisma, { partnerId: 'cp1', clientId: 'bajaj', trigger, actorId: 'approver', readMode });

describe('applyHeldOpeningBalancesForPartner — automatic apply at wallet birth / KYC approval', () => {
  it('LEGACY tenant (never backfilled): posts the dated passbook exactly like the bulk import, closing matches, rows un-sequenced', async () => {
    const db = emptyDb();
    const row = seed(db);
    const out = await run(fakePrisma(db), mode('LEGACY'));
    expect(out).toEqual([expect.objectContaining({ status: 'APPLIED', walletId: 'w1', sequencing: 'LEGACY_UNSEQUENCED', balanceAfter: 600 })]);
    const w = db.wallets[0];
    expect([w.redeemablePoints, w.earnedPoints, w.lifetimeEarned, w.redeemedPoints, w.lifetimeRedeemed, w.expiredPoints, w.lifetimeExpired]).toEqual([600, 900, 900, 200, 200, 100, 100]);
    expect(w.lastTransactionAt).toEqual(new Date('2026-06-30T00:00:04.000Z'));
    expect(w.movementSeq).toBe(0);
    expect(db.walletTxns.map((t) => [t.transactionType, t.points, t.balanceBefore, t.balanceAfter, t.balanceType, t.seq])).toEqual([
      ['CREDIT_POINTS_EARNED', 500, 0, 500, 'REDEEMABLE', null],
      ['CREDIT_POINTS_EARNED', 400, 500, 900, 'REDEEMABLE', null],
      ['DEBIT_REDEMPTION', -200, 900, 700, 'REDEEMABLE', null],
      ['DEBIT_EXPIRY', -100, 700, 600, 'REDEEMABLE', null],
    ]);
    expect(db.walletTxns[0].metadata).toEqual({ src: 'held-opening-balance', batch: row.source, ref: '50100001:tl:1', heldOpeningBalanceId: row.id });
    expect(db.ledger.map((l) => [l.transactionType, l.points, l.remainingPoints, l.expiresAt, l.sourceType, l.sourceId])).toEqual([
      ['EARN', 500, 200, null, 'VENDOR_IMPORT', '50100001:tl:1'],
      ['EARN', 400, 400, null, 'VENDOR_IMPORT', '50100001:tl:2'],
      ['REDEEM', -200, 0, null, 'VENDOR_IMPORT', '50100001:tl:3'],
      ['EXPIRE', -100, 0, null, 'VENDOR_IMPORT', '50100001:tl:4'],
    ]);
    const h = db.held[0];
    expect([h.status, h.applyMode, h.appliedWalletId, h.appliedBy, h.failureReason]).toEqual(['APPLIED', 'FULL_PASSBOOK', 'w1', 'KYC_APPROVAL', null]);
    expect(h.appliedAt).toBeInstanceOf(Date);
    expect(db.audits).toEqual([expect.objectContaining({ entityType: 'HELD_OPENING_BALANCE', entityId: row.id, actorId: 'approver' })]);
    expect(db.bells).toHaveLength(0);
  });

  it('V2 tenant: the new wallet is sequenced in the same transaction by the backfill planner → backfillStatus DONE (V2 switch guard counts it)', async () => {
    const db = emptyDb();
    seed(db);
    const out = await run(fakePrisma(db), mode('V2'));
    expect(out[0]).toEqual(expect.objectContaining({ status: 'APPLIED', sequencing: 'SEQUENCED' }));
    const w = db.wallets[0];
    expect([w.redeemablePoints, w.movementSeq, w.debtPoints, w.backfillStatus]).toEqual([600, 4, 0, 'DONE']);
    expect(db.walletTxns.map((t) => [t.seq, t.pointsDelta])).toEqual([[1, 500], [2, 400], [3, -200], [4, -100]]);
    // every movement is paired 1:1 with its ledger row
    expect(new Set(db.walletTxns.map((t) => t.pointsLedgerId)).size).toBe(4);
    for (const t of db.walletTxns) expect(db.ledger.find((l) => l.id === t.pointsLedgerId)?.sourceId).toBe(t.metadata.ref);
    // the V2 switch guard's "unprepared" predicate (movementSeq 0 with history) no longer matches this wallet
    expect(w.movementSeq > 0).toBe(true);
  });

  it('SHADOW tenant and a LEGACY tenant whose wallets were already backfilled are sequenced too', async () => {
    for (const setup of ['SHADOW', 'LEGACY-backfilled'] as const) {
      const db = emptyDb();
      seed(db);
      if (setup === 'LEGACY-backfilled') {
        db.partners.push({ id: 'cp2', clientId: 'bajaj' });
        db.wallets.push(blankWallet('w2', 'cp2', { movementSeq: 7, backfillStatus: 'DONE', redeemablePoints: 70 }));
      }
      const out = await run(fakePrisma(db), mode(setup === 'SHADOW' ? 'SHADOW' : 'LEGACY'));
      expect(out[0].sequencing).toBe('SEQUENCED');
      expect(db.wallets[0].backfillStatus).toBe('DONE');
    }
  });

  it('a negative mid-history dip on a V2 tenant is sequenced with the backfill planner and still ties out', async () => {
    const db = emptyDb();
    seed(db, {
      closing: 150,
      events: [
        { d: '2025-04-01', t: 'ADJUST', p: -300, l: "Last year's over-redemption recovered" },
        { d: '2025-05-01', t: 'EARN', p: 200, l: 'Points earned' },
        { d: '2025-06-01', t: 'EARN', p: 250, l: 'Points earned' },
      ],
    });
    const out = await run(fakePrisma(db), mode('V2'));
    expect(out[0].status).toBe('APPLIED');
    expect(db.wallets[0].redeemablePoints).toBe(150);
    expect(out[0].sequencing).toBe('SEQUENCED');
    expect(db.wallets[0]).toEqual(expect.objectContaining({ movementSeq: 3, backfillStatus: 'DONE', debtPoints: 0 }));
  });

  it('a malformed engine flag never blocks: LEGACY (un-sequenced) and the row says why', async () => {
    const db = emptyDb();
    seed(db);
    const out = await run(fakePrisma(db), async () => {
      throw new InvalidReversalEngineSettingException('bogus');
    });
    expect(out[0].status).toBe('APPLIED');
    expect(db.held[0].sequencing).toMatch(/^LEGACY_UNSEQUENCED \(engine setting unreadable/);
  });

  it('closing ≠ Σ events → FAILED with the reason, NOTHING posted, Gifsy admins belled (active only)', async () => {
    const db = emptyDb();
    seed(db, { closing: 601 });
    const out = await run(fakePrisma(db), mode('LEGACY'));
    expect(out[0].status).toBe('FAILED');
    expect(db.held[0].status).toBe('FAILED');
    expect(db.held[0].failureReason).toMatch(/adds up to 600 pts but the closing balance is 601/);
    expect(db.walletTxns).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
    expect(db.wallets[0].redeemablePoints).toBe(0);
    expect(db.bells.map((b) => [b.userId, b.channel, b.status])).toEqual([['gadmin', 'IN_APP', 'SENT']]);
    expect(db.bells[0].variables.url).toBe('/gifsy/held-opening-balances?clientId=bajaj');
  });

  it('a failure mid-posting rolls back to the savepoint — never partially posted — and marks FAILED', async () => {
    const db = emptyDb();
    seed(db);
    const out = await run(fakePrisma(db, { failOn: { op: 'ledger.createMany', error: 'disk full' } }), mode('LEGACY'));
    expect(out[0].status).toBe('FAILED');
    expect(db.held[0].failureReason).toMatch(/posting rolled back — disk full/);
    expect(db.walletTxns).toHaveLength(0); // the wallet_transactions insert before the failure was rolled back
    expect(db.wallets[0]).toEqual(expect.objectContaining({ redeemablePoints: 0, earnedPoints: 0, movementSeq: 0 }));
    expect(db.bells).toHaveLength(1);
  });

  it('idempotent: a second approval / re-run never double-posts', async () => {
    const db = emptyDb();
    seed(db);
    const prisma = fakePrisma(db);
    await run(prisma, mode('LEGACY'));
    const again = await run(prisma, mode('LEGACY'), 'CREDIT_CONFIRM');
    expect(again).toEqual([]);
    expect(db.walletTxns).toHaveLength(4);
    expect(db.wallets[0].redeemablePoints).toBe(600);
  });

  it('wallet already has activity → NOT applied automatically (stays PENDING for a Gifsy "Apply now"), nothing written', async () => {
    const db = emptyDb();
    seed(db);
    Object.assign(db.wallets[0], { redeemablePoints: 40, earnedPoints: 40, lifetimeEarned: 40 });
    db.walletTxns.push({ id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', points: 40, balanceBefore: 0, balanceAfter: 40, balanceType: 'REDEEMABLE', createdAt: new Date() });
    const out = await run(fakePrisma(db), mode('LEGACY'));
    expect(out[0]).toEqual(expect.objectContaining({ status: 'NOT_PRISTINE', balanceBefore: 40 }));
    expect(db.held[0].status).toBe('PENDING');
    expect(db.walletTxns).toHaveLength(1);
    expect(db.bells).toHaveLength(0);
  });

  it('two held rows for one owner (would pool into one wallet) → both FAILED, nothing posted', async () => {
    const db = emptyDb();
    seed(db);
    db.outlets.push({ id: 'o2', clientId: 'bajaj', outletCode: '50100002', partnerId: 'cp1', name: 'Branch', deletedAt: null });
    db.held.push(heldRow({ outletCode: '50100002', closingPoints: 10, events: [{ d: '2025-04-01', t: 'EARN', p: 10, l: 'Points earned' }] }));
    const out = await run(fakePrisma(db), mode('LEGACY'));
    expect(out.map((o) => o.status)).toEqual(['FAILED', 'FAILED']);
    expect(db.held.every((h) => h.status === 'FAILED' && /pool into ONE wallet/.test(h.failureReason))).toBe(true);
    expect(db.walletTxns).toHaveLength(0);
  });

  it('tenant isolation: a held row with the same outlet code in ANOTHER tenant is never applied', async () => {
    const db = emptyDb();
    seed(db);
    db.held[0].clientId = 'deoleo';
    const out = await run(fakePrisma(db), mode('LEGACY'));
    expect(out).toEqual([]);
    expect(db.held[0].status).toBe('PENDING');
    expect(db.walletTxns).toHaveLength(0);
  });

  it('dormant: a tenant with no held rows costs two reads and writes nothing', async () => {
    const db = emptyDb();
    seed(db);
    db.held.length = 0;
    const prisma = fakePrisma(db);
    expect(await run(prisma, mode('V2'))).toEqual([]);
    expect(prisma._ops).toEqual(['outlets.findMany', 'held.findMany']);
  });
});
