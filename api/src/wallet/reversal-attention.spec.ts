// Wallet Reversal Engine — policy round A call-outs (owner rule "no silent pass-throughs", 2026-11-16):
// GET /v1/admin/credits/reversal-engine/attention (WalletService.reversalAttention), the GIFSY pause switch
// (WalletService.setPointsReversalPause), the pause parser + tx-routed settings reads (TenantSettingsService), and the
// pure Q3 narrowing helpers (reversal-policy.ts).
import { blockedWalletsWhere, readinessOf, unsequencedWithHistoryWhere, WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { parsePointsReversalPause, TenantSettingsService } from '../tenant/tenant-settings.service';
import {
  approvalsPausedMessage,
  batchLineAmount,
  creditUnmappedMessage,
  unresolvedBlockingLine,
  walletNotSequencedMessage,
  walletsNotSequencedReadinessMessage,
} from './reversal-policy';

/**
 * `oldEngineRow`: what a left-behind `reversalEngine` program_settings row holds (the per-tenant mode was RETIRED
 * 2026-11-21 — the value must be ignored, whatever it is). `pendingCount` / `blockedCount`: the wallet counts.
 */
function attentionHarness(
  oldEngineRow: unknown,
  pauseValue: unknown = undefined,
  opts: {
    expiryRows?: any[]; refusalRows?: any[]; cappedRows?: any[]; untrackedRows?: any[];
    pendingCount?: number; blockedCount?: number;
  } = {},
) {
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
  const expiryRows = opts.expiryRows ?? [];
  const refusalRows = opts.refusalRows ?? [];
  const cappedRows = opts.cappedRows ?? [];
  const untrackedRows = opts.untrackedRows ?? [];
  const auditRows = (a: any) =>
    a.where.entityType === 'POINTS_EXPIRY_FAILURE'
      ? expiryRows
      : a.where.entityType === 'POINTS_EXPIRY_OFFSET_CAPPED'
        ? cappedRows
        : a.where.entityType === 'REVERSAL_EXPIRY_UNTRACKED'
          ? untrackedRows
          : refusalRows;
  const prisma = {
    wallet: {
      // BLOCKED query = blockedWalletsWhere (backfillStatus 'BLOCKED'); the other = unsequencedWithHistoryWhere
      count: rec('wallet.count', (a: any) =>
        a.where.backfillStatus === 'BLOCKED' ? opts.blockedCount ?? 1 : opts.pendingCount ?? 1,
      ),
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
        if (key === 'reversalEngine') return oldEngineRow === undefined ? null : { settingValue: oldEngineRow };
        return pauseValue === undefined ? null : { settingValue: pauseValue };
      }),
      upsert: rec('programSetting.upsert', {}),
    },
    auditLog: {
      create: rec('auditLog.create', {}),
      count: rec('auditLog.count', (a: any) => auditRows(a).length),
      findMany: rec('auditLog.findMany', (a: any) => auditRows(a)),
    },
    client: { findFirst: rec('client.findFirst', (a: any) => (a.where.id === 'nope' ? null : { id: a.where.id })) },
    $queryRaw: rec('$queryRaw', []),
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  const settings = new TenantSettingsService(prisma as unknown as PrismaService);
  const svc = new WalletService(prisma as unknown as PrismaService, settings);
  return { svc, prisma, calls };
}

describe('GET reversal-engine/attention (WalletService.reversalAttention)', () => {
  it('every tenant: BLOCKED + not-yet-backfilled wallets with reasons, unmapped credits, "recovered X, owed Y", pause state', async () => {
    const SINCE = '2026-11-16T03:00:00.000Z';
    const { svc, calls } = attentionHarness(undefined, { paused: true, since: SINCE, by: 'wallet-backfill', reason: 'APPLY' });
    const r = await svc.reversalAttention('bajaj');
    // the retired engine mode is gone from the response
    expect(r).not.toHaveProperty('mode');
    expect(r).not.toHaveProperty('effectiveMode');
    expect(r).not.toHaveProperty('modeWarning');
    expect(r).not.toHaveProperty('modeError');
    expect(r.pause).toEqual({ paused: true, since: SINCE, by: 'wallet-backfill', reason: 'APPLY' });
    expect(r.walletsTotal).toBe(2);
    expect(r.wallets.map((w) => [w.walletId, w.status, w.reason, w.outletCodes])).toEqual([
      ['w-b', 'BLOCKED', 'CHAIN_BROKEN: x', ['O1', 'O2']],
      ['w-n', 'NOT_BACKFILLED', 'not yet prepared by the wallet backfill', []],
    ]);
    expect(r.wallets[0].action).toMatch(/Earning and redeeming keep working.*fix the wallet history, then re-run/);
    expect(r.wallets[1].action).toMatch(/Gifsy: run the wallet backfill for this program\.$/);
    expect(r.unmappedCredits[0]).toMatchObject({ positionId: 'u1', batchId: 'B1', amount: 50, reason: expect.stringMatching(/could not be matched to an outlet and field/) });
    expect(r.owedClawbacks).toEqual([
      expect.objectContaining({ creditReversalId: 'R9', recovered: 100, owed: 200, label: 'recovered 100, owed 200' }),
    ]);
    // tenant-scoped queries only (never another tenant's wallets)
    for (const a of calls['wallet.count']) expect(a.where.partner).toEqual({ clientId: 'bajaj' });
    expect(calls['pos.count'][0].where).toEqual({ attribution: 'UNRESOLVED', wallet: { partner: { clientId: 'bajaj' } } });
    // owner 2026-11-19: a live V2 over-reversal's debt is the engine's normal outcome, not an attention item —
    // only HISTORICAL clawbacks (overReversalDebt false) are listed
    expect(calls['alloc.count'][0].where).toEqual({ owed: { gt: 0 }, overReversalDebt: false, creditReversal: { clientId: 'bajaj' } });
  });

  it('a tenant that had no reversalEngine row (Deoleo-like, was LEGACY): un-sequenced wallets with history ARE listed and counted', async () => {
    const { svc, calls } = attentionHarness(undefined, undefined, { pendingCount: 4, blockedCount: 1 });
    const r = await svc.reversalAttention('deoleo');
    expect(r.wallets.map((w) => w.status)).toEqual(['BLOCKED', 'NOT_BACKFILLED']);
    expect(r.walletsNotBackfilled).toBe(4);
    expect(r.walletsBlocked).toBe(1);
    expect(r.walletsTotal).toBe(5);
    expect(calls['wallet.count']).toHaveLength(2);
    expect(r.pause.paused).toBe(false);
    expect(r.readiness).toEqual({
      unsequencedWithHistory: 4,
      blocked: 1,
      ready: false,
      message:
        '4 wallets with points history are not yet prepared for reversals — Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C; ' +
        '1 wallet was blocked by the wallet backfill — Gifsy must fix its history and re-run it. Points reversals on these wallets are refused until then.',
    });
  });

  it('readiness: nothing to sequence (fresh tenant / Deoleo with zero history) → ready, no message', async () => {
    const { svc } = attentionHarness(undefined, undefined, { pendingCount: 0, blockedCount: 0 });
    const r = await svc.reversalAttention('deoleo');
    expect(r.readiness).toEqual({ unsequencedWithHistory: 0, blocked: 0, ready: true, message: null });
  });

  it('an old reversalEngine row is IGNORED whatever it holds (LEGACY / SHADOW / V2 / malformed): same response, never read', async () => {
    const shapes: string[] = [];
    for (const old of ['LEGACY', 'SHADOW', 'V2', 'v2', { x: 1 }, undefined]) {
      const { svc, calls } = attentionHarness(old, undefined, { pendingCount: 2, blockedCount: 0 });
      const r = await svc.reversalAttention('bajaj');
      shapes.push(JSON.stringify({ ...r, wallets: r.wallets.map((w) => ({ ...w, checkedAt: null })) }));
      const keys = (calls['programSetting.findUnique'] ?? []).map((a: any) => a.where.clientId_settingKey.settingKey);
      expect(keys).not.toContain('reversalEngine');
    }
    expect(new Set(shapes).size).toBe(1);
  });
});

describe('reversal readiness (one engine since 2026-11-21)', () => {
  it('reversalReadiness(clientId): the two tenant-scoped counts', async () => {
    const { svc, calls } = attentionHarness(undefined, undefined, { pendingCount: 7, blockedCount: 2 });
    await expect(svc.reversalReadiness('bajaj')).resolves.toMatchObject({ unsequencedWithHistory: 7, blocked: 2, ready: false });
    const wheres = calls['wallet.count'].map((a: any) => a.where);
    expect(wheres).toEqual(expect.arrayContaining([unsequencedWithHistoryWhere('bajaj'), blockedWalletsWhere('bajaj')]));
  });

  it('unsequencedWithHistoryWhere is NULL-safe on backfillStatus (OR null / DONE — never `{ not: BLOCKED }`) and covers every figure + any row', () => {
    const w: any = unsequencedWithHistoryWhere('t1');
    expect(w.partner).toEqual({ clientId: 't1' });
    expect(w.movementSeq).toBe(0);
    expect(w.AND[0]).toEqual({ OR: [{ backfillStatus: null }, { backfillStatus: 'DONE' }] });
    expect(JSON.stringify(w)).not.toMatch(/"not":"BLOCKED"/);
    const history = w.AND[1].OR;
    for (const f of ['redeemablePoints', 'debtPoints', 'earnedPoints', 'lockedPoints', 'redeemedPoints', 'expiredPoints', 'lifetimeEarned', 'lifetimeRedeemed', 'lifetimeExpired']) {
      expect(history).toContainEqual({ [f]: { not: 0 } });
    }
    expect(history).toContainEqual({ transactions: { some: {} } });
    expect(blockedWalletsWhere('t1')).toEqual({ partner: { clientId: 't1' }, movementSeq: 0, backfillStatus: 'BLOCKED' });
  });

  it('readinessOf / messages: plain words, singular and plural', () => {
    expect(readinessOf(0, 0)).toEqual({ unsequencedWithHistory: 0, blocked: 0, ready: true, message: null });
    expect(readinessOf(1, 0).message).toBe(
      '1 wallet with points history is not yet prepared for reversals — Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C. Points reversals on these wallets are refused until then.',
    );
    expect(readinessOf(0, 3)).toMatchObject({ ready: false });
    expect(walletsNotSequencedReadinessMessage(0, 3)).toBe(
      '3 wallets were blocked by the wallet backfill — Gifsy must fix their history and re-run it. Points reversals on these wallets are refused until then.',
    );
    // B1: names the client by its display name and states the exact next step
    expect(walletNotSequencedMessage('O1', 'Bajaj Consumer Care Ltd')).toBe(
      "Can't reverse: the wallet of outlet O1 (Bajaj Consumer Care Ltd) has points history that has not been prepared for reversals yet. Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C, then retry. Nothing was changed — earning and redeeming on this wallet keep working meanwhile.",
    );
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

  it('getPointsReversalPauseUncached uses the db handle it is given (the tx), not its own client', async () => {
    const own = { programSetting: { findUnique: jest.fn(async () => null) } };
    const tx = { programSetting: { findUnique: jest.fn(async () => ({ settingValue: { paused: true, since: 'S' } })) } };
    const s = new TenantSettingsService(own as unknown as PrismaService);
    await expect(s.getPointsReversalPauseUncached('t', tx as never)).resolves.toMatchObject({ paused: true });
    expect(tx.programSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(own.programSetting.findUnique).not.toHaveBeenCalled();
    await expect(s.getPointsReversalPauseUncached('t')).resolves.toMatchObject({ paused: false });
    expect(own.programSetting.findUnique).toHaveBeenCalledTimes(1);
    // the retired engine-mode reader is gone
    expect((s as unknown as Record<string, unknown>).getReversalEngineModeUncached).toBeUndefined();
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

// ───────────────────────── fix round A (money audit, 2026-11-16) ─────────────────────────

const gifsyHome = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', assumed: false };
const gifsyInBajaj = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true };

describe('fix round A — M1 attention call-outs', () => {
  it('expiry-sweep failures (last 30 days, this tenant) and Gifsy-must-act reversal refusals are listed with their reasons', async () => {
    const at = new Date();
    const { svc, calls } = attentionHarness('V2', undefined, {
      expiryRows: [{ createdAt: at, entityId: 'bajaj', metadata: { lotId: 'L1', walletId: 'w1', error: 'boom' } }],
      refusalRows: [
        {
          createdAt: at, entityId: 'rev1',
          metadata: { phase: 'APPROVE', code: 'CREDIT_UNMAPPED', message: "Can't reverse: …", outletId: 'O1', batchId: 'B1', reason: 'sequenced wallet: no credit position records this credit' },
        },
      ],
    });
    const r = await svc.reversalAttention('bajaj');
    expect(r.expiryFailuresTotal).toBe(1);
    expect(r.expiryFailures[0]).toMatchObject({ lotId: 'L1', walletId: 'w1', error: 'boom', action: expect.stringMatching(/retried by the next expiry sweep/) });
    expect(r.refusalsTotal).toBe(1);
    expect(r.refusals[0]).toMatchObject({ entityId: 'rev1', phase: 'APPROVE', code: 'CREDIT_UNMAPPED', outletCode: 'O1', reason: 'sequenced wallet: no credit position records this credit' });
    // tenant-scoped: expiry failures by entityId = tenant, refusals by metadata.clientId; the pause has its own line
    const where = calls['auditLog.count'].map((a: any) => a.where);
    expect(where[0]).toMatchObject({ entityType: 'POINTS_EXPIRY_FAILURE', entityId: 'bajaj' });
    expect(where[1]).toMatchObject({
      entityType: 'REVERSAL_ENGINE_REFUSAL',
      metadata: { path: ['clientId'], equals: 'bajaj' },
      NOT: { metadata: { path: ['code'], equals: 'APPROVALS_PAUSED' } },
    });
  });
});

describe('audit B8 (2026-11-19) — an expiry that repaid debt beyond the credit position is never log-only', () => {
  it('is listed on the attention endpoint (this tenant, last 30 days) with the amount not booked and what to do', async () => {
    const at = new Date();
    const { svc, calls } = attentionHarness('V2', undefined, {
      cappedRows: [{ createdAt: at, entityId: 'w9', metadata: { clientId: 'bajaj', walletId: 'w9', lotId: 'L9', batchId: 'B9', outletCode: 'O9', offsetNotRecorded: 40 } }],
    });
    const r = await svc.reversalAttention('bajaj');
    expect(r.expiryOffsetCappedTotal).toBe(1);
    expect(r.expiryOffsetCapped[0]).toMatchObject({
      walletId: 'w9', lotId: 'L9', batchId: 'B9', outletCode: 'O9', offsetNotRecorded: 40,
      action: expect.stringMatching(/a later reversal of that credit restores that much less debt/),
    });
    const capped = calls['auditLog.count'].map((a: any) => a.where).find((w: any) => w.entityType === 'POINTS_EXPIRY_OFFSET_CAPPED');
    expect(capped).toMatchObject({ metadata: { path: ['clientId'], equals: 'bajaj' } });
  });
});

describe('round 6 item 5 — an untracked-expiry reversal lists EVERY affected wallet', () => {
  it('walletIds = every wallet in metadata.positions (deduped, sorted), not only the first', async () => {
    const at = new Date();
    const { svc } = attentionHarness('V2', undefined, {
      untrackedRows: [
        {
          createdAt: at, entityId: 'REVU',
          metadata: {
            clientId: 'bajaj', walletId: 'w2', outletCode: 'O2', owed: 30, recovered: 10,
            positions: [
              { positionId: 'p1', walletId: 'w2', creditTxId: 't1', owed: 10, recovered: 5 },
              { positionId: 'p2', walletId: 'w1', creditTxId: 't2', owed: 20, recovered: 5 },
              { positionId: 'p3', walletId: 'w2', creditTxId: 't3', owed: 0, recovered: 0 },
            ],
          },
        },
        // an older row without positions still names its wallet
        { createdAt: at, entityId: 'REVO', metadata: { clientId: 'bajaj', walletId: 'w9', owed: 5 } },
      ],
    });
    const r = await svc.reversalAttention('bajaj');
    expect(r.expiryUntracked.map((u: any) => [u.creditReversalId, u.walletId, u.walletIds])).toEqual([
      ['REVU', 'w2', ['w1', 'w2']],
      ['REVO', 'w9', ['w9']],
    ]);
  });
});

describe('fix round A — L6 target tenant of the GIFSY pause / mode actions', () => {
  it('un-assumed Gifsy (home tenant) without an explicit clientId → refused, NOTHING written to the home tenant', async () => {
    const { svc, calls } = attentionHarness('V2');
    await expect(svc.setPointsReversalPause(gifsyHome, { paused: false })).rejects.toThrow(/^Choose the program: you are not working inside a client program/);
    expect(calls['programSetting.upsert']).toBeUndefined();
  });

  it('un-assumed Gifsy WITH an explicit clientId → that tenant (must exist)', async () => {
    const { svc, calls } = attentionHarness('V2');
    await expect(svc.setPointsReversalPause(gifsyHome, { paused: false, clientId: 'nope' })).rejects.toThrow(/No client program "nope"/);
    const res = await svc.setPointsReversalPause(gifsyHome, { paused: false, clientId: 'bajaj' });
    expect(res).toMatchObject({ clientId: 'bajaj', paused: false });
    expect(calls['programSetting.upsert'][0].where).toEqual({ clientId_settingKey: { clientId: 'bajaj', settingKey: 'pointsReversalApprovalsPaused' } });
    expect(calls['auditLog.create'][0].data.entityId).toBe('bajaj');
  });

  it('working inside a tenant (assumed): that tenant; a different explicit clientId is refused', async () => {
    const { svc, calls } = attentionHarness('V2');
    await expect(svc.setPointsReversalPause(gifsyInBajaj, { paused: true, clientId: 'deoleo' })).rejects.toThrow(/You are working in bajaj/);
    expect(calls['programSetting.upsert']).toBeUndefined();
    await svc.setPointsReversalPause(gifsyInBajaj, { paused: true });
    expect(calls['programSetting.upsert'][0].create.clientId).toBe('bajaj');
  });
});

describe('GET reversal-engine/wallets-in-debt (audit item 9 + fix rounds 3/4 + owner D1/D2)', () => {
  const approvedAt = new Date('2026-11-19T06:00:00Z');
  const harness = (allocs: unknown[], lastNonNeg: unknown[] = [], rows: unknown[] = [], noNegatives = false) => {
    const calls: Record<string, any[]> = {};
    const rec = (k: string, ret: unknown) => jest.fn(async (a: any) => ((calls[k] ??= []).push(a), ret));
    const prisma: any = {
      wallet: {
        count: rec('wallet.count', 3),
        aggregate: rec('wallet.aggregate', { _sum: { redeemablePoints: -3867 } }),
        findMany: rec('wallet.findMany', [
          { id: 'w1', partnerId: 'p1', redeemablePoints: -2986, debtPoints: 2986, movementSeq: 9, partner: { businessName: 'Shop One' } },
          { id: 'w2', partnerId: 'p2', redeemablePoints: -841, debtPoints: 841, movementSeq: 0, partner: { businessName: 'Shop Two' } },
        ]),
      },
      outlet: {
        findMany: rec('outlet.findMany', [
          { partnerId: 'p1', outletCode: 'O1', programName: 'Gold' },
          { partnerId: 'p2', outletCode: 'O2', programName: 'Silver' },
        ]),
      },
      // round 6: allocations are read ONLY for the reversals found after each wallet's last row at or above zero
      creditReversalAllocation: {
        findMany: jest.fn(async (a: any) => {
          (calls['alloc.findMany'] ??= []).push(a);
          return (allocs as any[]).filter((x) => a.where.creditReversalId.in.includes(x.creditReversalId));
        }),
      },
      walletTransaction: {
        groupBy: rec('wt.groupBy', lastNonNeg),
        // round 6: the DB filters reversal rows to those AFTER each wallet's last row at or above zero — emulate it
        findMany: jest.fn(async (a: any) => {
          (calls['wt.findMany'] ??= []).push(a);
          return (rows as any[]).filter(
            (r) =>
              r.creditReversalId &&
              a.where.OR.some(
                (c: any) =>
                  c.walletId === r.walletId &&
                  (!c.seq || (r.seq != null && r.seq > c.seq.gt)) &&
                  (!c.createdAt || r.createdAt > c.createdAt.gt),
              ),
          );
        }),
      },
      // round 6 (items 2/4): the cheap probe is raw SQL with a LITERAL `< 0` (partial index usable)
      $queryRaw: rec('$queryRaw', noNegatives ? [] : [{ one: 1 }]),
      $executeRawUnsafe: rec('$executeRawUnsafe', 0),
    };
    // round 5 (A2): one INTERACTIVE read-only REPEATABLE READ transaction
    prisma.$transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>, o: unknown) => {
      (calls['$transaction'] ??= []).push(o);
      return cb(prisma);
    });
    const svc = new WalletService(prisma as unknown as PrismaService, {} as TenantSettingsService);
    return { svc, calls };
  };

  it('only wallets BELOW ZERO (D1), one REPEATABLE READ snapshot, totals from full aggregates, outlet CODE from the position', async () => {
    const { svc, calls } = harness(
      [
        {
          id: 'al1', creditReversalId: 'REV1', owed: 2986, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2',
          position: { walletId: 'w1', outletCode: 'O1' },
          creditReversal: { approvedAt, fieldName: 'Volume', period: '2026-10' },
        },
      ],
      [{ walletId: 'w1', _max: { seq: 7, createdAt: null } }],
      [{ walletId: 'w1', creditReversalId: 'REV1', seq: 9, createdAt: approvedAt }],
    );
    const res = await svc.walletsInDebt('bajaj', { limit: 2 });
    expect(calls['wallet.count'][0].where).toEqual({ partner: { clientId: 'bajaj' }, redeemablePoints: { lt: 0 } });
    // round 6 (item 1): explicit timeouts sized for 5,000 wallets (Prisma defaults 5 s / 2 s expire under load)
    expect(calls['$transaction'][0]).toEqual({ isolationLevel: 'RepeatableRead', timeout: 30_000, maxWait: 10_000 });
    // capped reads: only the listed wallets; reversal rows only after the last ≥ 0 seq; allocations only of those reversals
    expect(calls['wt.groupBy'][0].where).toEqual({ walletId: { in: ['w1', 'w2'] }, balanceAfter: { gte: 0 } });
    expect(calls['wt.findMany'][0].where).toEqual({
      creditReversalId: { not: null },
      OR: [{ walletId: 'w1', seq: { gt: 7 } }, { walletId: 'w2' }],
    });
    expect(calls['alloc.findMany'][0].where).toMatchObject({ creditReversalId: { in: ['REV1'] }, position: { walletId: { in: ['w1', 'w2'] } } });
    expect(res.anyNegative).toBe(true);
    expect(calls['$executeRawUnsafe'][0]).toBe('SET TRANSACTION READ ONLY');
    expect(calls['outlet.findMany'].at(-1).where).toMatchObject({ deletedAt: null }); // B8
    expect(res).toMatchObject({ total: 3, totalOwedPoints: 3867, truncated: true, availablePrograms: ['Gold', 'Silver'] });
    expect(res.wallets[0]).toMatchObject({
      walletId: 'w1', outletCodes: ['O1'], balance: -2986, owedPoints: 2986, note: null,
      sources: [{ allocationId: 'al1', creditReversalId: 'REV1', kind: 'OVER_REVERSAL', owedPoints: 2986, outletCode: 'O1' }],
    });
    expect(res.wallets[1]).toMatchObject({ walletId: 'w2', owedPoints: 841, sources: [], note: expect.stringMatching(/imported/) });
  });

  it('item 2: decided by SEQ, not approvedAt — a reversal approved "before" a later earn still counts when its row comes after the last ≥ 0 row; both positions of one reversal are listed', async () => {
    const early = new Date('2026-11-01T00:00:00Z'); // approvedAt stamped before the lock / an earlier clock
    const { svc } = harness(
      [
        { id: 'a1', creditReversalId: 'RX', owed: 100, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2', position: { walletId: 'w1', outletCode: 'O1' }, creditReversal: { approvedAt: early, fieldName: 'F', period: 'P' } },
        { id: 'a2', creditReversalId: 'RX', owed: 50, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2', position: { walletId: 'w1', outletCode: 'O1' }, creditReversal: { approvedAt: early, fieldName: 'F', period: 'P' } },
        { id: 'a3', creditReversalId: 'ROLD', owed: 10, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2', position: { walletId: 'w1', outletCode: 'O1' }, creditReversal: { approvedAt: early, fieldName: 'F', period: 'P' } },
      ],
      [{ walletId: 'w1', _max: { seq: 5, createdAt: new Date('2026-11-20T00:00:00Z') } }],
      [
        { walletId: 'w1', creditReversalId: 'RX', seq: 6, createdAt: early },
        { walletId: 'w1', creditReversalId: 'RX', seq: 7, createdAt: early },
        { walletId: 'w1', creditReversalId: 'ROLD', seq: 3, createdAt: early },
      ],
    );
    const res = await svc.walletsInDebt('bajaj');
    expect(res.wallets[0].sources.map((x: { allocationId: string }) => x.allocationId)).toEqual(['a1', 'a2']);
  });

  it('programName applies the dashboards programme scope', async () => {
    const { svc, calls } = harness([]);
    await svc.walletsInDebt('bajaj', { programName: 'Gold' });
    expect(calls['wallet.count'][0].where.partner).toMatchObject({ clientId: 'bajaj', outlets: { some: expect.objectContaining({ programName: { in: ['Gold'] } }) } });
  });

  it('round 5 B1: a tenant with NO negative wallet answers from the cheap probe — no catalogue, no snapshot', async () => {
    const { svc, calls } = harness([], [], [], true);
    const res = await svc.walletsInDebt('deoleo');
    expect(res).toMatchObject({ total: 0, totalOwedPoints: 0, wallets: [], truncated: false, anyNegative: false });
    // round 6 (item 4): tenant-scoped raw probe with a LITERAL `< 0` (the clientId is the only bound value)
    const probe = calls['$queryRaw'][0];
    expect(probe.sql).toMatch(/w\."redeemablePoints" < 0 LIMIT 1/);
    expect(probe.text).toMatch(/cp\."clientId" = \$1 AND/); // the Postgres text binds ONLY the tenant id
    expect(probe.values).toEqual(['deoleo']);
    expect(calls['$transaction']).toBeUndefined();
    expect(calls['outlet.findMany']).toBeUndefined();
  });

  it('round 6: no reversal row after the last ≥ 0 row → no allocation query at all', async () => {
    const { svc, calls } = harness([], [{ walletId: 'w1', _max: { seq: 9, createdAt: null } }], [{ walletId: 'w1', creditReversalId: 'ROLD', seq: 3, createdAt: approvedAt }]);
    const res = await svc.walletsInDebt('bajaj');
    expect(calls['alloc.findMany']).toBeUndefined();
    expect(res.wallets[0].sources).toEqual([]);
  });

  it('round 6 (items 2/4): anyWalletBelowZero answers the probe on its own', async () => {
    expect(await harness([], [], [], true).svc.anyWalletBelowZero('deoleo')).toBe(false);
    expect(await harness([]).svc.anyWalletBelowZero('bajaj')).toBe(true);
  });

  it('round 5 B7: a last row at or above zero WITHOUT seq (pre-sequencing history) falls back to time', async () => {
    const before = new Date('2026-10-01T00:00:00Z');
    const after = new Date('2026-11-19T00:00:00Z');
    const { svc } = harness(
      [
        { id: 'a1', creditReversalId: 'RNEW', owed: 5, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2', position: { walletId: 'w1', outletCode: 'O1' }, creditReversal: { approvedAt: after, fieldName: 'F', period: 'P' } },
        { id: 'a2', creditReversalId: 'ROLD', owed: 5, debtRestored: 0, debtExposed: 0, overReversalDebt: true, engineSource: 'V2', position: { walletId: 'w1', outletCode: 'O1' }, creditReversal: { approvedAt: before, fieldName: 'F', period: 'P' } },
      ],
      [{ walletId: 'w1', _max: { seq: null, createdAt: new Date('2026-11-01T00:00:00Z') } }],
      [
        { walletId: 'w1', creditReversalId: 'RNEW', seq: 9, createdAt: after },
        { walletId: 'w1', creditReversalId: 'ROLD', seq: 4, createdAt: before },
      ],
    );
    const res = await svc.walletsInDebt('bajaj');
    expect(res.wallets[0].sources.map((x: { creditReversalId: string }) => x.creditReversalId)).toEqual(['RNEW']);
  });
});
