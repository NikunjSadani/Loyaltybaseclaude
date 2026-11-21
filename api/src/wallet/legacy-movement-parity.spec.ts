// Wallet Reversal Engine — fix round A, L5, re-scoped 2026-11-21 when the per-tenant LEGACY mode was retired: proof that
// a wallet with UN-sequenced history (the backfill has not processed it) still takes EXACTLY the pre-engine write path:
// the same Prisma statements, in the same order, with the same arguments — as origin/main. (A PRISTINE wallet is now
// always sequenced, and the interim reversal gate + floor-0 clawback were deleted, so those parts of the recording are
// no longer compared — only its MOVEMENT prefix, steps 1–6, which is unchanged.)
//
// How: one Deoleo-style scenario (batch credit, plain credit, redemption, refused redemption, refund, admin credit +
// debit; then an expiry sweep) is driven through WalletService against an in-memory database that RECORDS every
// statement (model.method + normalised args, raw SQL text). The recording made by origin/main's WalletService
// (2eb8271d) is the committed fixture __fixtures__/legacy-movement-parity.origin-main.json (it also holds the old
// gate / clawback / sweep statements — kept as recorded, not regenerated); this branch must reproduce its first
// steps-1–6 statements exactly. The ONLY allowed difference is documented and normalised in
// `canonical()`: the fast path's wallet UPDATE carries `movementSeq: 0` in its WHERE (atomic guard against a backfill
// sequencing the wallet between the caller's read and the write — one `UPDATE … WHERE id = $1 AND "movementSeq" = 0`,
// still ONE statement).
//
// Regenerate the fixture (only when origin/main's wallet code legitimately changes):
//   git show origin/main:api/src/wallet/wallet.service.ts > api/src/wallet/__origin_main_wallet.service.ts
//   WALLET_PARITY_IMPL=./__origin_main_wallet.service WALLET_PARITY_WRITE=1 node node_modules/jest/bin/jest.js \
//     --config package.json src/wallet/legacy-movement-parity --no-coverage
//   rm api/src/wallet/__origin_main_wallet.service.ts
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { AdjustType } from './dto/wallet.dto';

type Row = Record<string, any>;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const FIXTURE = path.join(__dirname, '__fixtures__', 'legacy-movement-parity.origin-main.json');
const IMPL = process.env.WALLET_PARITY_IMPL ?? './wallet.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WalletService } = require(IMPL) as typeof import('./wallet.service');

const num = (x: any) => (x instanceof Date ? x.getTime() : x);
function matchWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      const ranged = 'gt' in v || 'gte' in v || 'lt' in v || 'lte' in v;
      if (ranged && (row[k] === null || row[k] === undefined)) return false;
      if ('in' in v) { if (!(v as any).in.includes(row[k])) return false; }
      if ('gt' in v && !(num(row[k]) > num((v as any).gt))) return false;
      if ('gte' in v && !(num(row[k]) >= num((v as any).gte))) return false;
      if ('lt' in v && !(num(row[k]) < num((v as any).lt))) return false;
      if ('lte' in v && !(num(row[k]) <= num((v as any).lte))) return false;
      // other objects = relation filters (tenant scope) — not modelled here
    } else if (row[k] !== v) return false;
  }
  return true;
}
function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if ('decrement' in v) row[k] = (row[k] ?? 0) - (v as any).decrement;
      else row[k] = v;
    } else row[k] = v;
  }
}
function orderRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const [key, dir] = Object.entries(s)[0] as [string, string];
      const d = num(a[key]) < num(b[key]) ? -1 : num(a[key]) > num(b[key]) ? 1 : 0;
      if (d !== 0) return dir === 'asc' ? d : -d;
    }
    return 0;
  });
}
/** Real-time Dates → '<now>', fake-clock Dates → offsets (WAYS #10: nothing hard-coded to the calendar). */
function normalise(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), (_k, v) => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const t = new Date(v).getTime() - NOW.getTime();
      return Math.abs(t) < 10_000_000 ? `<clock${t >= 0 ? '+' : ''}${t}>` : '<now>';
    }
    return v;
  });
}

function recordingDb() {
  let clock = 0;
  const later = () => new Date(NOW.getTime() + ++clock);
  const T: Record<string, Row[]> = {
    wallet: [
      // A Deoleo-style wallet: history, never negative, never sequenced (movementSeq 0 — the default column value).
      {
        id: 'w1', partnerId: 'cp1', redeemablePoints: 1000, earnedPoints: 1000, lockedPoints: 0, redeemedPoints: 0,
        expiredPoints: 0, lifetimeEarned: 1000, lifetimeRedeemed: 0, lifetimeExpired: 0, debtPoints: 0, movementSeq: 0,
        backfillStatus: null, backfillBlockedReason: null,
      },
    ],
    walletTransaction: [
      { id: 'wt-open', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', points: 1000, balanceBefore: 0, balanceAfter: 1000, referenceType: null, referenceId: null, metadata: null, createdAt: new Date(NOW.getTime() - 5_000_000) },
    ],
    pointsLedger: [
      { id: 'pl-open', walletId: 'w1', transactionType: 'EARN', points: 1000, remainingPoints: 1000, isExpired: false, expiresAt: new Date(NOW.getTime() - 1000), schemeId: null, createdAt: new Date(NOW.getTime() - 5_000_000) },
    ],
    channelPartner: [{ id: 'cp1', clientId: 'deoleo' }],
    outlet: [{ clientId: 'deoleo', outletCode: 'O1', partnerId: 'cp1' }],
    creditBatch: [{ id: 'B1', clientId: 'deoleo', rows: [{ outletId: 'O1', fieldId: 'F', amount: 500, awardType: 'POINTS', status: 'OK' }] }],
    pointExpiryConfig: [],
    auditLog: [],
    walletCreditPosition: [],
    programSetting: [],
  };
  const log: { op: string; args?: unknown }[] = [];
  const rec = (op: string, args: unknown) => log.push({ op, args: normalise(args) });
  const model = (name: string) => ({
    findFirst: async (a: any = {}) => {
      rec(`${name}.findFirst`, a);
      const r = orderRows(T[name].filter((x) => matchWhere(x, a.where)), a.orderBy)[0];
      return r ? { ...r } : null;
    },
    findUnique: async (a: any = {}) => {
      rec(`${name}.findUnique`, a);
      const r = T[name].find((x) => matchWhere(x, a.where));
      return r ? { ...r } : null;
    },
    findUniqueOrThrow: async (a: any = {}) => {
      rec(`${name}.findUniqueOrThrow`, a);
      const r = T[name].find((x) => matchWhere(x, a.where));
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return { ...r };
    },
    findMany: async (a: any = {}) => {
      rec(`${name}.findMany`, a);
      let rows = orderRows(T[name].filter((x) => matchWhere(x, a.where)), a.orderBy);
      if (a.take != null) rows = rows.slice(0, a.take);
      return rows.map((r) => ({ ...r }));
    },
    count: async (a: any = {}) => {
      rec(`${name}.count`, a);
      return T[name].filter((x) => matchWhere(x, a.where)).length;
    },
    create: async (a: any) => {
      rec(`${name}.create`, a);
      const row = { id: `${name}-${clock + 1}`, isExpired: false, remainingPoints: 0, createdAt: later(), ...a.data };
      T[name].push(row);
      return { ...row };
    },
    update: async (a: any) => {
      rec(`${name}.update`, a);
      const r = T[name].find((x) => matchWhere(x, a.where));
      if (!r) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      applyData(r, a.data);
      return { ...r };
    },
    updateMany: async (a: any) => {
      rec(`${name}.updateMany`, a);
      const rows = T[name].filter((x) => matchWhere(x, a.where));
      rows.forEach((r) => applyData(r, a.data));
      return { count: rows.length };
    },
  });
  const db: Row = Object.fromEntries(Object.keys(T).map((k) => [k, model(k)]));
  db.$queryRaw = async (strings: TemplateStringsArray) => {
    rec('$queryRaw', Array.isArray(strings) ? strings.join('?') : String(strings));
    return [];
  };
  db.$transaction = async (cb: any) => {
    rec('$transaction', null);
    return cb(db);
  };
  const settingsCalls: string[] = [];
  const tenantSettings = new Proxy(
    {},
    {
      get: (_t, prop: string) => async (...args: unknown[]) => {
        settingsCalls.push(prop);
        rec(`tenantSettings.${prop}`, args.slice(0, 1));
        if (prop === 'getConversionRate') return 1;
        return null;
      },
    },
  );
  return { T, db, log, tenantSettings, settingsCalls };
}

async function scenario() {
  const h = recordingDb();
  const svc = new WalletService(h.db as never, h.tenantSettings as never);
  const out: Row = { errors: [] };
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return `${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
  };
  // 1. a credit-batch credit (confirmBatch shape — metadata; a LEGACY batch passes no mode on origin/main)
  out.credit1 = await svc.creditEarn('cp1', 'deoleo', 500, {
    referenceType: 'CREDIT_BATCH', referenceId: 'B1', sourceType: 'CREDIT_FIELD', sourceId: 'F',
    description: 'credit B1', metadata: { fieldId: 'F', outletCode: 'O1' },
  });
  // 2. a plain credit (points engine / manual)
  out.credit2 = await svc.creditEarn('cp1', 'deoleo', 100, { description: 'plain credit' });
  // 3. a redemption + 4. a refused one
  out.redeem = await svc.debitRedeem('cp1', 200, { referenceId: 'ord-1' });
  out.errors.push(await err(svc.debitRedeem('cp1', 99_999, { referenceId: 'ord-2' })));
  // 5. refund of a redemption
  out.refund = await svc.reverse('cp1', 50, { referenceId: 'ord-1' });
  // 6. Gifsy manual credit + debit
  const gifsy = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' } as never;
  out.adjustCredit = await svc.adjust(gifsy, { partnerId: 'cp1', type: AdjustType.CREDIT, amount: 30, reason: 'r', approvedBy: 'a' } as never);
  out.adjustDebit = await svc.adjust(gifsy, { partnerId: 'cp1', type: AdjustType.DEBIT, amount: 20, reason: 'r', approvedBy: 'a' } as never);
  // The movement prefix ends here (the fixture's step 7 — the deleted interim gate + LEGACY clawback — is not replayed).
  const movementStatements = h.log.length;
  const movementsOut = normalise(out) as Row;
  // 8. the expiry sweep (the opening lot is due) — on the same un-sequenced wallet, still the pre-engine clamp
  const sweep = (await svc.expireDuePoints({ now: NOW })) as Row;
  out.sweep = { expiredLots: sweep.expiredLots, expiredPoints: sweep.expiredPoints };
  return { h, movementStatements, movementsOut, log: h.log };
}

/**
 * The documented differences — same statements, same count, only these argument details — stripped exactly:
 *  1. the L5 fast path adds `movementSeq: 0` to the WHERE of the wallet UPDATE it already issues (atomic guard);
 *  2. the interim reversal gate's wallet read (assertPointsReversalAllowed — a reversal REQUEST, not a movement)
 *     selects two more columns of the same row: `debtPoints` (Q14 debt refusal, reversal-engine branch) and
 *     `movementSeq` (positions are read only for a sequenced wallet — fix round A).
 */
function canonical(log: { op: string; args?: any }[]) {
  return log.map((e) => {
    if ((e.op === 'wallet.update' || e.op === 'wallet.updateMany') && e.args?.where?.movementSeq === 0) {
      const { movementSeq: _guard, ...where } = e.args.where;
      return { ...e, args: { ...e.args, where } };
    }
    if (e.op === 'wallet.findFirst' && e.args?.select?.redeemablePoints && (e.args.select.debtPoints || e.args.select.movementSeq)) {
      const { debtPoints: _d, movementSeq: _m, ...select } = e.args.select;
      return { ...e, args: { ...e.args, select } };
    }
    return e;
  });
}

describe('L5 — un-sequenced wallet WITH history ≡ origin/main pre-engine path (statement-for-statement)', () => {
  it('movements (batch credit, plain credit, redeem, refused redeem, refund, admin credit + debit): same statements, order, arguments and results as origin/main 2eb8271d', async () => {
    const { log, movementStatements, movementsOut, h } = await scenario();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    // eslint-disable-next-line no-console
    console.log(`[L5 parity] movement prefix: origin/main ${movementStatements} of ${fixture.log.length} statements compared`);
    expect(canonical(log.slice(0, movementStatements))).toEqual(canonical(fixture.log.slice(0, movementStatements)));
    // the fixture continues with the (deleted) interim reversal gate — the prefix boundary is exact
    expect(fixture.log[movementStatements]?.op).toBe('$transaction');
    for (const k of ['credit1', 'credit2', 'redeem', 'refund', 'adjustCredit', 'adjustDebit', 'errors']) {
      expect(movementsOut[k]).toEqual(fixture.snapshot.out[k]);
    }
    // nothing of the engine is touched: no tenant-setting read at all, no position, no seq — on every step incl. the sweep
    expect(h.settingsCalls).toEqual([]);
    expect(h.T.walletCreditPosition).toHaveLength(0);
    expect(h.T.walletTransaction.every((t) => t.seq === undefined && t.pointsDelta === undefined)).toBe(true);
    expect(h.T.wallet[0].movementSeq).toBe(0);
  });

  it('per-movement statement counts (the query-count proof, readable): identical to origin/main for the movement prefix', async () => {
    const { log, movementStatements } = await scenario();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const counts = (l: { op: string }[]) => l.reduce<Record<string, number>>((m, e) => ((m[e.op] = (m[e.op] ?? 0) + 1), m), {});
    expect(counts(log.slice(0, movementStatements))).toEqual(counts(fixture.log.slice(0, movementStatements)));
    // no tenant lookup per movement (the retired engine-mode read needed one)
    expect(log.filter((e) => e.op === 'channelPartner.findFirst')).toHaveLength(
      fixture.log.slice(0, movementStatements).filter((e: { op: string }) => e.op === 'channelPartner.findFirst').length,
    );
  });

  it('the expiry sweep on that wallet stays on the pre-engine clamp (no seq, no position) and never fails', async () => {
    const { h, log, movementStatements } = await scenario();
    const sweepOps = log.slice(movementStatements).map((e) => e.op);
    expect(sweepOps).not.toContain('walletCreditPosition.findFirst');
    expect(h.T.walletTransaction.filter((t) => t.transactionType === 'DEBIT_EXPIRY').every((t) => t.seq === undefined)).toBe(true);
  });
});