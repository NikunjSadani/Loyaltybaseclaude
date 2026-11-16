// Wallet Reversal Engine — policy round A call-outs (owner rule "no silent pass-throughs", 2026-11-16):
// GET /v1/admin/credits/reversal-engine/attention (WalletService.reversalAttention), the GIFSY pause switch
// (WalletService.setPointsReversalPause), the pause parser + tx-routed settings reads (TenantSettingsService), and the
// pure Q3 narrowing helpers (reversal-policy.ts).
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { parsePointsReversalPause, TenantSettingsService } from '../tenant/tenant-settings.service';
import { approvalsPausedMessage, batchLineAmount, creditUnmappedMessage, unresolvedBlockingLine } from './reversal-policy';

function attentionHarness(
  mode: 'LEGACY' | 'SHADOW' | 'V2' | 'BAD',
  pauseValue: unknown = undefined,
  opts: { expiryRows?: any[]; refusalRows?: any[]; walletCount?: number } = {},
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
  const prisma = {
    wallet: {
      // `NOT` = the V2-flip "not prepared by the backfill" query (fix round A, M2)
      count: rec('wallet.count', (a: any) => (a.where.NOT ? opts.walletCount ?? 0 : a.where.backfillStatus === 'BLOCKED' ? 1 : 1)),
      findMany: rec('wallet.findMany', (a: any) =>
        a.where.NOT ? Array.from({ length: Math.min(opts.walletCount ?? 0, a.take ?? 99) }, (_, i) => ({ id: `w-u${i}` })) : a.where.backfillStatus === 'BLOCKED' ? blocked : pending,
      ),
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
    auditLog: {
      create: rec('auditLog.create', {}),
      count: rec('auditLog.count', (a: any) => (a.where.entityType === 'POINTS_EXPIRY_FAILURE' ? expiryRows.length : refusalRows.length)),
      findMany: rec('auditLog.findMany', (a: any) => (a.where.entityType === 'POINTS_EXPIRY_FAILURE' ? expiryRows : refusalRows)),
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

// ───────────────────────── fix round A (money audit, 2026-11-16) ─────────────────────────

const gifsyHome = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'gifsy', assumed: false };
const gifsyInBajaj = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true };

describe('fix round A — M1 attention call-outs', () => {
  it('a malformed flag is LOUD: "invalid … treated as LEGACY; fix in settings", effective mode LEGACY, un-backfilled wallets not listed as problems', async () => {
    const { svc } = attentionHarness('BAD');
    const r = await svc.reversalAttention('bajaj');
    expect(r).toMatchObject({ clientId: 'bajaj', mode: 'INVALID', effectiveMode: 'LEGACY' });
    expect(r.modeWarning).toMatch(/^reversalEngine setting is invalid: "v2" — treated as LEGACY; fix in settings\. /);
    expect(r.modeWarning).toMatch(/points reversal requests and approvals are refused until a Gifsy Admin sets a valid engine mode/);
    expect(r.walletsNotBackfilled).toBe(0);
  });

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

describe('fix round A — M2 POST reversal-engine/mode (WalletService.setReversalEngineMode)', () => {
  it('validates the value; nothing written on a bad one', async () => {
    const { svc, calls } = attentionHarness('LEGACY');
    await expect(svc.setReversalEngineMode(gifsyInBajaj, { mode: 'v2' })).rejects.toThrow(/reversalEngine must be one of LEGACY \| SHADOW \| V2 \(got "v2"\)/);
    expect(calls['programSetting.upsert']).toBeUndefined();
  });

  it('→ V2 refused while wallets with history are not prepared by the backfill (and not listed BLOCKED); takes the EXCLUSIVE engine lock first; nothing written', async () => {
    const { svc, calls } = attentionHarness('LEGACY', undefined, { walletCount: 7 });
    await expect(svc.setReversalEngineMode(gifsyInBajaj, { mode: 'V2' })).rejects.toThrow(
      /^Can't switch the reversal engine to V2: 7 wallet\(s\) with points history have not been prepared by the wallet backfill and are not listed as blocked \(e\.g\. w-u0, w-u1, w-u2, w-u3, w-u4\) — run the wallet backfill APPLY/,
    );
    expect(String(calls['$queryRaw'][0].join('?'))).toContain('pg_advisory_xact_lock(hashtextextended(');
    const unprepared = calls['wallet.count'].find((a: any) => a.where.NOT).where;
    expect(unprepared).toMatchObject({
      partner: { clientId: 'bajaj' },
      movementSeq: 0,
      NOT: { backfillStatus: 'BLOCKED', backfillBlockedReason: { not: null } },
    });
    expect(calls['programSetting.upsert']).toBeUndefined();
    expect(calls['auditLog.create']).toBeUndefined();
  });

  it('→ V2 / SHADOW refused while POINTS reversal approvals are paused (backfill running)', async () => {
    const { svc, calls } = attentionHarness('LEGACY', { paused: true, since: 'S' });
    for (const mode of ['V2', 'SHADOW']) {
      await expect(svc.setReversalEngineMode(gifsyInBajaj, { mode })).rejects.toThrow(
        new RegExp(`^Can't switch the reversal engine to ${mode} while points reversal approvals are paused \\(wallet maintenance started S\\)`),
      );
    }
    expect(calls['programSetting.upsert']).toBeUndefined();
  });

  it('→ V2 when every wallet is prepared: writes the row + an audit row (old → new, reason, BLOCKED count), busts the cache', async () => {
    const { svc, calls } = attentionHarness('SHADOW', undefined, { walletCount: 0 });
    const res = await svc.setReversalEngineMode(gifsyInBajaj, { mode: 'V2', reason: 'Bajaj go-live' });
    expect(res).toMatchObject({ clientId: 'bajaj', mode: 'V2', previous: 'SHADOW', blockedWalletsListed: 1 });
    expect(res.note).toMatch(/1 wallet\(s\) are BLOCKED by the wallet backfill/);
    const up = calls['programSetting.upsert'][0];
    expect(up.where).toEqual({ clientId_settingKey: { clientId: 'bajaj', settingKey: 'reversalEngine' } });
    expect(up.update.settingValue).toBe('V2');
    expect(calls['auditLog.create'][0].data).toMatchObject({
      action: 'UPDATE', entityType: 'REVERSAL_ENGINE_MODE', entityId: 'bajaj', actorId: 'g1',
      oldValues: { value: 'SHADOW' }, newValues: { value: 'V2' }, metadata: { reason: 'Bajaj go-live', blockedWalletsListed: 1 },
    });
  });

  it('→ LEGACY (rollback) is ALWAYS allowed — even paused, even with un-prepared wallets, even from a malformed value', async () => {
    const { svc, calls } = attentionHarness('BAD', { paused: true, since: 'S' }, { walletCount: 9 });
    await expect(svc.setReversalEngineMode(gifsyInBajaj, { mode: 'LEGACY' })).resolves.toMatchObject({ mode: 'LEGACY', previous: 'v2' });
    expect(calls['programSetting.upsert'][0].update.settingValue).toBe('LEGACY');
  });
});

describe('fix round A — L6 target tenant of the GIFSY pause / mode actions', () => {
  it('un-assumed Gifsy (home tenant) without an explicit clientId → refused, NOTHING written to the home tenant', async () => {
    const { svc, calls } = attentionHarness('V2');
    await expect(svc.setPointsReversalPause(gifsyHome, { paused: false })).rejects.toThrow(/^Choose the program: you are not working inside a client program/);
    await expect(svc.setReversalEngineMode(gifsyHome, { mode: 'LEGACY' })).rejects.toThrow(/^Choose the program/);
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
