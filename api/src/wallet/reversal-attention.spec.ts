// Wallet Reversal Engine — policy round A call-outs (owner rule "no silent pass-throughs", 2026-11-16):
// GET /v1/admin/credits/reversal-engine/attention (WalletService.reversalAttention), the GIFSY pause switch
// (WalletService.setPointsReversalPause), the pause parser + tx-routed settings reads (TenantSettingsService), and the
// pure Q3 narrowing helpers (reversal-policy.ts).
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { parsePointsReversalPause, TenantSettingsService } from '../tenant/tenant-settings.service';
import { approvalsPausedMessage, batchLineAmount, creditUnmappedMessage, unresolvedBlockingLine } from './reversal-policy';

function attentionHarness(mode: 'LEGACY' | 'V2' | 'BAD', pauseValue: unknown = undefined) {
  const calls: Record<string, any[]> = {};
  const rec = (k: string, ret: unknown) =>
    jest.fn(async (args: any) => {
      (calls[k] ??= []).push(args);
      return typeof ret === 'function' ? (ret as (a: any) => unknown)(args) : ret;
    });
  const blocked = [
    { id: 'w-b', partnerId: 'p-b', backfillStatus: 'BLOCKED', backfillBlockedReason: 'CHAIN_BROKEN: x', backfillCheckedAt: new Date(0), partner: { businessName: 'Shop B' } },
  ];
  const pending = [{ id: 'w-n', partnerId: 'p-n', backfillStatus: null, backfillBlockedReason: null, backfillCheckedAt: null, partner: { businessName: 'Shop N' } }];
  const prisma = {
    wallet: {
      count: rec('wallet.count', (a: any) => (a.where.backfillStatus === 'BLOCKED' ? 1 : 1)),
      findMany: rec('wallet.findMany', (a: any) => (a.where.backfillStatus === 'BLOCKED' ? blocked : pending)),
    },
    outlet: { findMany: rec('outlet.findMany', [{ partnerId: 'p-b', outletCode: 'O2' }, { partnerId: 'p-b', outletCode: 'O1' }]) },
    walletCreditPosition: {
      count: rec('pos.count', 1),
      findMany: rec('pos.findMany', [
        { id: 'u1', walletId: 'w-x', creditTxId: 't1', batchId: 'B1', outletCode: null, fieldId: null, amount: 50, reversedPoints: 0 },
      ]),
    },
    creditReversalAllocation: {
      count: rec('alloc.count', 1),
      findMany: rec('alloc.findMany', [
        {
          creditReversalId: 'R9', requested: 400, debtRestored: 0, recovered: 100, owed: 200, shortfall: 100,
          position: { walletId: 'w-q', batchId: 'BQ', outletCode: 'OQ', fieldId: 'F1' },
        },
      ]),
    },
    programSetting: {
      findUnique: rec('programSetting.findUnique', (a: any) => {
        const key = a.where.clientId_settingKey.settingKey;
        if (key === 'reversalEngine') return mode === 'BAD' ? { settingValue: 'v2' } : { settingValue: mode };
        return pauseValue === undefined ? null : { settingValue: pauseValue };
      }),
      upsert: rec('programSetting.upsert', {}),
    },
    auditLog: { create: rec('auditLog.create', {}) },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  const settings = new TenantSettingsService(prisma as unknown as PrismaService);
  const svc = new WalletService(prisma as unknown as PrismaService, settings);
  return { svc, prisma, calls };
}

describe('GET reversal-engine/attention (WalletService.reversalAttention)', () => {
  it('V2 tenant: BLOCKED + not-yet-backfilled wallets with reasons, unmapped credits, "recovered X, owed Y", pause state', async () => {
    const SINCE = '2026-11-16T03:00:00.000Z';
    const { svc, calls } = attentionHarness('V2', { paused: true, since: SINCE, by: 'wallet-backfill', reason: 'APPLY' });
    const r = await svc.reversalAttention('bajaj');
    expect(r.mode).toBe('V2');
    expect(r.pause).toEqual({ paused: true, since: SINCE, by: 'wallet-backfill', reason: 'APPLY' });
    expect(r.walletsTotal).toBe(2);
    expect(r.wallets.map((w) => [w.walletId, w.status, w.reason, w.outletCodes])).toEqual([
      ['w-b', 'BLOCKED', 'CHAIN_BROKEN: x', ['O1', 'O2']],
      ['w-n', 'NOT_BACKFILLED', 'not yet prepared by the wallet backfill', []],
    ]);
    expect(r.wallets[0].action).toMatch(/Earning and redeeming keep working/);
    expect(r.unmappedCredits[0]).toMatchObject({ positionId: 'u1', batchId: 'B1', amount: 50, reason: expect.stringMatching(/could not be matched to an outlet and field/) });
    expect(r.owedClawbacks).toEqual([
      expect.objectContaining({ creditReversalId: 'R9', recovered: 100, owed: 200, label: 'recovered 100, owed 200' }),
    ]);
    // tenant-scoped queries only (never another tenant's wallets)
    for (const a of calls['wallet.count']) expect(a.where.partner).toEqual({ clientId: 'bajaj' });
    expect(calls['pos.count'][0].where).toEqual({ attribution: 'UNRESOLVED', wallet: { partner: { clientId: 'bajaj' } } });
    expect(calls['alloc.count'][0].where).toEqual({ owed: { gt: 0 }, creditReversal: { clientId: 'bajaj' } });
  });

  it('LEGACY tenant: un-backfilled wallets are the normal state → not listed (only BLOCKED ones)', async () => {
    const { svc, calls } = attentionHarness('LEGACY');
    const r = await svc.reversalAttention('deoleo');
    expect(r.wallets.map((w) => w.status)).toEqual(['BLOCKED']);
    expect(r.walletsNotBackfilled).toBe(0);
    expect(calls['wallet.count']).toHaveLength(1);
    expect(r.pause.paused).toBe(false);
  });

  it('a malformed engine flag is reported (never hidden), the rest still listed', async () => {
    const { svc } = attentionHarness('BAD');
    const r = await svc.reversalAttention('t');
    expect(r.mode).toBe('INVALID');
    expect(r.modeError).toMatch(/Invalid reversalEngine setting/);
  });
});

describe('POST reversal-engine/pause (WalletService.setPointsReversalPause)', () => {
  it('writes the switch with since/by and an audit row; lifting it records who and when', async () => {
    const { svc, calls, prisma } = attentionHarness('V2');
    await svc.setPointsReversalPause({ sub: 'g1', clientId: 'bajaj' }, { paused: true, reason: 'manual hold' });
    const up = calls['programSetting.upsert'][0];
    expect(up.where).toEqual({ clientId_settingKey: { clientId: 'bajaj', settingKey: 'pointsReversalApprovalsPaused' } });
    expect(up.create.settingValue).toMatchObject({ paused: true, by: 'g1', reason: 'manual hold', since: expect.any(String) });
    expect(calls['auditLog.create'][0].data).toMatchObject({ action: 'UPDATE', entityType: 'POINTS_REVERSAL_PAUSE', entityId: 'bajaj', actorId: 'g1' });
    await svc.setPointsReversalPause({ sub: 'g2', clientId: 'bajaj' }, { paused: false });
    expect(calls['programSetting.upsert'][1].update.settingValue).toMatchObject({ paused: false, by: 'g2' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe('TenantSettingsService — Q5 pause parser + reads through the caller tx (WP7 pool fix)', () => {
  it('parsePointsReversalPause: absent / {paused:false} → off; {paused:true} → on; anything else fails CLOSED', () => {
    expect(parsePointsReversalPause(undefined).paused).toBe(false);
    expect(parsePointsReversalPause({ paused: false, clearedAt: 'x' }).paused).toBe(false);
    expect(parsePointsReversalPause({ paused: true, since: 'S', by: 'B' })).toEqual({ paused: true, since: 'S', by: 'B', reason: null });
    for (const bad of ['yes', true, [], { paused: 'true' }, 1]) {
      expect(parsePointsReversalPause(bad)).toMatchObject({ paused: true, malformed: true });
    }
  });

  it('getReversalEngineModeUncached / getPointsReversalPauseUncached use the db handle they are given (the tx), not their own client', async () => {
    const own = { programSetting: { findUnique: jest.fn(async () => null) } };
    const tx = { programSetting: { findUnique: jest.fn(async () => ({ settingValue: 'V2' })) } };
    const s = new TenantSettingsService(own as unknown as PrismaService);
    await expect(s.getReversalEngineModeUncached('t', tx as never)).resolves.toBe('V2');
    await s.getPointsReversalPauseUncached('t', tx as never);
    expect(tx.programSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(own.programSetting.findUnique).not.toHaveBeenCalled();
    await expect(s.getReversalEngineModeUncached('t')).resolves.toBe('LEGACY');
    expect(own.programSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('approvalsPausedMessage: owner wording with the start time', () => {
    expect(approvalsPausedMessage({ paused: true, since: 'S', by: null, reason: null })).toBe(
      'Points reversal approvals are paused — wallet maintenance in progress (started S)',
    );
  });
});

describe('Q3 narrowing (pure)', () => {
  const key = { outletCode: 'O1', fieldId: 'F1' };
  it('only a credit that could be THIS line blocks it; a fully identified line is never blocked by an unrelated one', () => {
    const anyLine = { outletCode: null, fieldId: null };
    expect(unresolvedBlockingLine([{ outletCode: 'O2', fieldId: null }], key, 0, 100)).toEqual([]);
    expect(unresolvedBlockingLine([{ outletCode: null, fieldId: 'F2' }], key, 0, 100)).toEqual([]);
    expect(unresolvedBlockingLine([anyLine], key, 100, 100)).toEqual([]); // line fully identified
    expect(unresolvedBlockingLine([anyLine], key, 60, 100)).toEqual([anyLine]); // part of the line unaccounted
    expect(unresolvedBlockingLine([anyLine], key, 100, null)).toEqual([anyLine]); // batch rows unknown → conservative
    const exact = { outletCode: 'O1', fieldId: 'F1' };
    expect(unresolvedBlockingLine([exact], key, 100, 100)).toEqual([exact]); // this line's own credit — always
  });
  it('batchLineAmount sums the POINTS / OK / > 0 rows of the line; non-array → unknown', () => {
    const rows = [
      { outletId: 'O1', fieldId: 'F1', amount: 70, awardType: 'POINTS', status: 'OK' },
      { outletId: 'O1', fieldId: 'F1', amount: 30, awardType: 'POINTS', status: 'OK' },
      { outletId: 'O1', fieldId: 'F1', amount: 99, awardType: 'POINTS', status: 'SKIPPED' },
      { outletId: 'O1', fieldId: 'F1', amount: 99, awardType: 'PAYOUT', status: 'OK' },
      { outletId: 'O1', fieldId: 'F2', amount: 99, awardType: 'POINTS', status: 'OK' },
    ];
    expect(batchLineAmount(rows, key)).toBe(100);
    expect(batchLineAmount(null, key)).toBeNull();
    expect(creditUnmappedMessage('O7')).toBe("Can't reverse: the original credit for outlet O7 in this batch couldn't be identified — Gifsy must map it first.");
  });
});
