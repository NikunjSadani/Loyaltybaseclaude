// WP5 — PAYOUT (₹) reversals under the Wallet Reversal Engine (WALLET-REVERSAL-ENGINE-DESIGN.md §8, §15 T-pay1..5).
// Runs CreditsService end-to-end against an in-memory Prisma fake WITH transaction rollback and the partial unique
// index on live payout allocations, so each test asserts the persisted state (entries, allocations, reversals, TDS
// ledger, downloads), not mock call shapes. LEGACY (default) behaviour is covered here at the dispatch level and,
// byte-for-byte, by the untouched assertions of credits.service.spec.ts.
// Run: npx jest src/credits/payout-reversal-v2.spec.ts

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreditsService } from './credits.service';
import { CreateReversalDto, PayoutGroupType, ReversalAction } from './dto/credits.dto';
import {
  classifyPayoutCandidates,
  planPayoutAllocationBackfill,
  reservePayoutEntries,
  BackfillPayoutEntry,
  BackfillPayoutReversal,
} from './payout-reversal-v2';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { DEFAULT_RESOLVED_TDS_STATUTORY } from '../tds/tds.helpers';
import { normalisePan } from '../tds/tds-194r.shared';

jest.mock('../common/reward-account.helper', () => ({ ensureOutletAccount: jest.fn().mockResolvedValue('acc-x') }));

// ─── In-memory Prisma fake ─────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;

const LIVE = ['RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE'];

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // An absent fake column reads as SQL NULL.
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  return a === b;
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  seq = 0;
  /** SQL text + values of every $queryRaw (row locks). */
  rawCalls: { sql: string; values: unknown[] }[] = [];
  /** SQL text + values of every $executeRaw (advisory locks, guarded tds_credits updates). */
  execCalls: { sql: string; values: unknown[] }[] = [];
  /** Test hook: runs right after the download record is created inside the download tx (before the claim). */
  onDownloadCreate: (() => void) | null = null;

  t(name: string): Row[] {
    return (this.tables[name] ??= []);
  }
  nextId(p: string) {
    return `${p}${++this.seq}`;
  }

  matchVal(v: unknown, c: any): boolean {
    if (c === undefined) return true;
    if (c !== null && typeof c === 'object' && !(c instanceof Date)) {
      if ('mode' in c) {
        // case-insensitive string match (only `in` / `equals` are used with it)
        const lc = (x: unknown) => (typeof x === 'string' ? x.toLowerCase() : x);
        if ('in' in c) return (c.in as unknown[]).some((x) => same(lc(v), lc(x)));
        if ('equals' in c) return same(lc(v), lc(c.equals));
      }
      if ('equals' in c) return same(v, c.equals);
      if ('in' in c) return (c.in as unknown[]).some((x) => same(v, x));
      if ('not' in c) return !this.matchVal(v, c.not);
      if ('startsWith' in c) return String(v).startsWith(c.startsWith);
      if ('gte' in c || 'lte' in c || 'gt' in c || 'lt' in c) {
        const x = v as any;
        if ('gte' in c && !(x >= c.gte)) return false;
        if ('lte' in c && !(x <= c.lte)) return false;
        if ('gt' in c && !(x > c.gt)) return false;
        if ('lt' in c && !(x < c.lt)) return false;
        return true;
      }
      throw new Error(`fake: unsupported condition ${Object.keys(c).join(',')}`);
    }
    return same(v, c);
  }

  match(table: string, row: Row, where: any): boolean {
    if (!where) return true;
    for (const [k, c] of Object.entries(where)) {
      if (c === undefined) continue;
      if (k === 'NOT') {
        if (c && this.match(table, row, c)) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(c as any[]).some((w) => this.match(table, row, w))) return false;
        continue;
      }
      if (k === 'AND') {
        if (!(c as any[]).every((w) => this.match(table, row, w))) return false;
        continue;
      }
      // 194R shared definition relation filters (collect194RBases): the entry's bank file + its batch.
      if (k === 'download' && table === 'creditPayoutEntry') {
        const d = this.t('creditPayoutDownload').find((x) => x.id === row.downloadId);
        if (!d || !this.match('creditPayoutDownload', d, c)) return false;
        continue;
      }
      if (k === 'batch' && table === 'creditPayoutEntry') {
        const b = this.t('creditBatch').find((x) => x.id === row.batchId) ?? {};
        if (!this.match('creditBatch', b, c)) return false;
        continue;
      }
      if (k === 'payoutEntry' && table === 'payoutReversalAllocation') {
        const e = this.t('creditPayoutEntry').find((x) => x.id === row.payoutEntryId);
        if (!e || !this.match('creditPayoutEntry', e, c)) return false;
        continue;
      }
      if (k === 'tdsCredit' && table === 'creditPayoutEntry') {
        // Relation filter `tdsCredit: { is: null }` (policy round B base exclusion).
        const has = this.t('tdsCredit').some((x) => x.sourcePayoutEntryId === row.id);
        if ((c as any).is === null && has) return false;
        continue;
      }
      if (k === 'reversalAllocations') {
        const allocs = this.t('payoutReversalAllocation').filter((a) => a.payoutEntryId === row.id);
        const rc = c as any;
        if (rc.none && allocs.some((a) => this.match('payoutReversalAllocation', a, rc.none))) return false;
        if (rc.some && !allocs.some((a) => this.match('payoutReversalAllocation', a, rc.some))) return false;
        continue;
      }
      if (!this.matchVal(row[k], c)) return false;
    }
    return true;
  }

  project(table: string, row: Row, args: any): Row {
    const out: Row = { ...row };
    const rel = { ...(args?.include ?? {}), ...(args?.select ?? {}) };
    if (table === 'creditPayoutEntry' && rel.batch) {
      out.batch = { ...this.t('creditBatch').find((b) => b.id === row.batchId) };
    }
    if (table === 'payoutReversalAllocation' && rel.payoutEntry) {
      out.payoutEntry = { ...this.t('creditPayoutEntry').find((e) => e.id === row.payoutEntryId) };
    }
    if (table === 'tdsCreditApplication' && rel.tdsCredit) {
      out.tdsCredit = { ...this.t('tdsCredit').find((c) => c.id === row.tdsCreditId) };
    }
    return out;
  }

  sort(rows: Row[], orderBy: any): Row[] {
    const keys: [string, 'asc' | 'desc'][] = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap(
      (o: Row) => Object.entries(o) as [string, 'asc' | 'desc'][],
    );
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }

  uniqueCheck(table: string, row: Row) {
    const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'fake' });
    if (table === 'tdsCredit') {
      // unique sourcePayoutEntryId + tds_credits_amounts_chk
      if (this.t(table).some((r) => r !== row && r.sourcePayoutEntryId === row.sourcePayoutEntryId)) throw dup();
      if (!(row.amountPaise > 0n) || row.appliedPaise < 0n || row.appliedPaise > row.amountPaise) throw new Error('CHECK tds_credits_amounts_chk');
      return;
    }
    if (table === 'tdsCreditApplication') {
      // partial unique tds_credit_applications_live_key (tdsCreditId, payoutEntryId) WHERE releasedAt IS NULL
      if (
        row.releasedAt === null &&
        this.t(table).some((r) => r !== row && r.releasedAt === null && r.tdsCreditId === row.tdsCreditId && r.payoutEntryId === row.payoutEntryId)
      ) throw dup();
      if (!(row.amountPaise > 0n)) throw new Error('CHECK tds_credit_applications_amount_chk');
      return;
    }
    if (table !== 'payoutReversalAllocation') return;
    if (row.receivablePaise !== undefined && (row.receivablePaise < 0n || row.tdsCreditPaise < 0n || row.receivablePaise > row.amountPaise)) {
      throw new Error('CHECK payout_reversal_allocations_receivable_chk');
    }
    const rows = this.t(table);
    const dupPair = rows.some(
      (r) => r !== row && r.creditReversalId === row.creditReversalId && r.payoutEntryId === row.payoutEntryId,
    );
    const dupLive =
      LIVE.includes(row.state) && rows.some((r) => r !== row && r.payoutEntryId === row.payoutEntryId && LIVE.includes(r.state));
    if (dupPair || dupLive) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'fake' });
    }
    if (!(row.amountPaise > 0n) || row.tdsOffsetPaise < 0n) throw new Error('CHECK payout_reversal_allocations_amounts_chk');
  }

  defaults(table: string, data: Row): Row {
    const now = new Date();
    const base: Row = { id: data.id ?? this.nextId(table.slice(0, 3)), createdAt: now, updatedAt: now };
    if (table === 'creditReversal') {
      Object.assign(base, {
        status: 'PENDING_GIFSY',
        shortfallPaise: 0n,
        consumedPayoutEntryIds: null,
        approvedPaise: null,
        approvedAt: null,
        approvedBy: null,
        remarks: null,
        requestedAt: now,
      });
    }
    if (table === 'payoutReversalAllocation') {
      Object.assign(base, { state: 'RESERVED', tdsOffsetPaise: 0n, receivablePaise: 0n, tdsCreditPaise: 0n });
    }
    if (table === 'tdsCredit') Object.assign(base, { appliedPaise: 0n });
    if (table === 'tdsCreditApplication') Object.assign(base, { releasedAt: null, releaseReason: null, downloadId: null });
    // Decimal columns (tdsRate) are stored as strings so the rollback snapshot (structuredClone) can copy them.
    const plain = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v instanceof Prisma.Decimal ? v.toString() : v]),
    );
    return { ...base, ...plain };
  }

  model(table: string) {
    return {
      findMany: async (args: any = {}) => {
        let rows = this.t(table).filter((r) => this.match(table, r, args.where));
        rows = this.sort(rows, args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => this.project(table, r, args));
      },
      findFirst: async (args: any = {}) => {
        const rows = this.sort(this.t(table).filter((r) => this.match(table, r, args.where)), args.orderBy);
        return rows[0] ? this.project(table, rows[0], args) : null;
      },
      findUnique: async (args: any = {}) => {
        const r = this.t(table).find((x) => this.match(table, x, args.where));
        return r ? this.project(table, r, args) : null;
      },
      count: async (args: any = {}) => this.t(table).filter((r) => this.match(table, r, args.where)).length,
      create: async (args: any) => {
        const row = this.defaults(table, args.data);
        this.t(table).push(row);
        this.uniqueCheck(table, row);
        if (table === 'creditPayoutDownload') this.onDownloadCreate?.();
        return { ...row };
      },
      createMany: async (args: any) => {
        for (const d of args.data) {
          const row = this.defaults(table, d);
          this.t(table).push(row);
          this.uniqueCheck(table, row);
        }
        return { count: args.data.length };
      },
      updateMany: async (args: any) => {
        const rows = this.t(table).filter((r) => this.match(table, r, args.where));
        for (const r of rows) {
          Object.assign(r, args.data, { updatedAt: new Date() });
          this.uniqueCheck(table, r);
        }
        return { count: rows.length };
      },
      update: async (args: any) => {
        const r = this.t(table).find((x) => this.match(table, x, args.where));
        if (!r) throw new Error(`fake: ${table}.update no row`);
        Object.assign(r, args.data, { updatedAt: new Date() });
        return { ...r };
      },
      upsert: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    };
  }

  client(): any {
    const db = this;
    const target: Row = {
      $queryRaw: async (strings: TemplateStringsArray | { strings: string[]; values: unknown[] }, ...values: unknown[]) => {
        if (!Array.isArray(strings) && 'strings' in strings) {
          // Prisma.sql object (CreditsService.scope194R): this client's partners whose NORMALISED PAN is in the list.
          const q = strings as { strings: string[]; values: unknown[] };
          const sql = q.strings.join('?');
          db.rawCalls.push({ sql, values: q.values });
          if (sql.includes('FROM "channel_partners"')) {
            const [clientId, pans] = q.values as [string, string[]];
            return db
              .t('channelPartner')
              .filter((p) => (p.clientId ?? TENANT) === clientId && p.panNumber && pans.includes(normalisePan(p.panNumber)))
              .map((p) => ({ id: p.id, panNumber: p.panNumber }));
          }
          return [];
        }
        db.rawCalls.push({ sql: (strings as TemplateStringsArray).join('?'), values });
        return [];
      },
      // Records every statement (advisory locks) and executes the two guarded tds_credits UPDATEs of tds-credit.ts.
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        db.execCalls.push({ sql, values });
        if (sql.includes('UPDATE tds_credits') && sql.includes('"appliedPaise" + ?')) {
          const [amount, id, clientId] = values as [bigint, string, string];
          // Merge decision 2026-11-19: a credit is used ONLY by the client that raised it (194C too).
          const c = db.t('tdsCredit').find((x) => x.id === id && x.clientId === clientId);
          if (!c || c.appliedPaise + amount > c.amountPaise) return 0;
          c.appliedPaise += amount;
          return 1;
        }
        // WRE D1 base marker — a RAW update on purpose (never bumps the PAID entry's updatedAt; digest tripwire).
        if (sql.includes('UPDATE "credit_payout_entries" SET "tdsBaseReversedAt"')) {
          const [at, reversalId, id] = values as [Date, string, string];
          const e = db.t('creditPayoutEntry').find((x) => x.id === id && x.tdsBaseReversedAt == null);
          if (!e) return 0;
          e.tdsBaseReversedAt = at;
          e.tdsBaseReversalId = reversalId;
          return 1;
        }
        if (sql.includes('UPDATE tds_credits') && sql.includes('"appliedPaise" - ?')) {
          const [amount, id] = values as [bigint, string];
          const c = db.t('tdsCredit').find((x) => x.id === id);
          if (!c || c.appliedPaise < amount) return 0;
          c.appliedPaise -= amount;
          return 1;
        }
        return 0;
      },
      $transaction: async (cb: (tx: any) => Promise<unknown>) => {
        const snapshot = structuredClone(db.tables);
        try {
          return await cb(proxy);
        } catch (e) {
          db.tables = snapshot; // rollback
          throw e;
        }
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return db.model(prop);
      },
    });
    return proxy;
  }
}

// ─── Fixture ───────────────────────────────────────────────────────────────────────────────────────────────────
const TENANT = 'bajaj';
const admin: JwtPayload = { sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT, phone: '', name: '' };
const gifsy: JwtPayload = { sub: 'gifsy-admin', role: 'GIFSY_ADMIN', clientId: TENANT, phone: '', name: '' };

function entry(id: string, amountPaise: bigint, status: string, extra: Row = {}): Row {
  return {
    id,
    clientId: TENANT,
    batchId: 'b1',
    downloadId: status === 'PROCESSING' || status === 'PAID' ? 'dl-old' : null,
    outletId: 'O1',
    outletName: 'Outlet One',
    fieldId: 'f1',
    fieldName: 'Volume',
    period: '2026-10',
    amountPaise,
    narration: '',
    status,
    utr: null,
    paidAt: null,
    tdsSection: null,
    tdsMethodology: null,
    tdsDeductedPaise: 0n,
    tdsBaseReversedAt: null,
    tdsBaseReversalId: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    ...extra,
  };
}

function setup(mode: 'LEGACY' | 'SHADOW' | 'V2' = 'V2') {
  const db = new FakeDb();
  db.t('creditBatch').push({
    id: 'b1',
    clientId: TENANT,
    batchCode: 'CB-2026-10-001',
    period: '2026-10',
    status: 'CONFIRMED',
    rows: [
      { outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 80_000 },
      { outletId: 'O2', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 20_000 },
    ],
  });
  // T-pay2 shape: [₹300 PAID, ₹500 PENDING] for O1/f1 — plus an unrelated O2 entry for downloads.
  db.t('creditPayoutEntry').push(
    entry('pe-a', 30_000n, 'PAID', { createdAt: new Date('2026-11-01T00:00:00Z') }),
    entry('pe-b', 50_000n, 'PENDING', { createdAt: new Date('2026-11-02T00:00:00Z') }),
    entry('pe-c', 20_000n, 'PENDING', { outletId: 'O2', outletName: 'Outlet Two' }),
  );
  const partner = (id: string) => ({
    id,
    userId: `u-${id}`,
    bankName: 'HDFC',
    bankAccountNumber: '123',
    bankAccountHolder: 'X',
    ifscCode: 'HDFC0001',
    upiId: '',
    isActive: true,
    deletedAt: null,
    panNumber: null,
    phone: '9900000000',
    kycSubmissions: [{ id: `k-${id}`, status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
  });
  db.t('outlet').push(
    { clientId: TENANT, outletCode: 'O1', name: 'Outlet One', isActive: true, state: null, phone: null, partner: partner('p1') },
    { clientId: TENANT, outletCode: 'O2', name: 'Outlet Two', isActive: true, state: null, phone: null, partner: partner('p2') },
  );
  const settings = {
    mode: mode as 'LEGACY' | 'SHADOW' | 'V2',
    getReversalEngineModeUncached: jest.fn(async () => settings.mode),
    getEffectiveSettings: jest.fn(async () => ({
      creditsPayouts: { monthCutoffDay: 31, safetyCapPoints: 1e6, safetyCapInr: 1e7, fourEyesEnabled: false, notifyEmails: [] },
    })),
    resolveTdsPolicy: jest.fn(async () => ({ section: 'SEC_194C', methodology: 'GROSS_UP' })),
  };
  const wallet = { assertPointsReversalAllowed: jest.fn(), creditedPointsForBatchRow: jest.fn(async () => 0n) };
  const service = new CreditsService(
    db.client(),
    { enqueue: jest.fn().mockResolvedValue({}), writeInApp: jest.fn(), notifyUser: jest.fn(), notifyUserWithChannels: jest.fn() } as any,
    { sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined) } as any,
    wallet as any,
    settings as any,
    { generateForBatch: jest.fn(), createTdsInvoice: jest.fn() } as any,
    { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) } as any,
  );
  const e = (id: string) => db.t('creditPayoutEntry').find((x) => x.id === id)!;
  const allocs = (reversalId?: string) =>
    db.t('payoutReversalAllocation').filter((a) => !reversalId || a.creditReversalId === reversalId);
  const reversal = (id: string) => db.t('creditReversal').find((r) => r.id === id)!;
  return { db, service, settings, wallet, e, allocs, reversal };
}

function req(amount: number, payoutEntryIds?: string[], outletId = 'O1'): CreateReversalDto {
  return {
    outletId,
    outletName: 'Outlet One',
    fieldId: 'f1',
    fieldName: 'Volume',
    awardType: 'PAYOUT' as any,
    originalPaise: 80_000,
    requestedPaise: amount,
    ...(payoutEntryIds ? { payoutEntryIds } : {}),
  };
}

const approve = (s: ReturnType<typeof setup>, id: string) =>
  s.service.patchReversal(gifsy, id, { action: ReversalAction.approve });
const reject = (s: ReturnType<typeof setup>, id: string) =>
  s.service.patchReversal(gifsy, id, { action: ReversalAction.reject, remarks: 'no' });
const download = (s: ReturnType<typeof setup>) =>
  s.service.createPayoutDownload(gifsy, { period: '2026-10', groupType: PayoutGroupType.STANDARD });

// ─── LEGACY dispatch ───────────────────────────────────────────────────────────────────────────────────────────
// Owner decision 1 (2026-11-16): SHADOW behaves exactly like LEGACY for PAYOUT reversals (today's screens + rules).
describe.each(['LEGACY', 'SHADOW'] as const)('WP5 — %s tenant keeps the interim PAYOUT behaviour', (mode) => {
  it('lists no entries (amount form), refuses an entry selection, and creates/approves exactly as the interim rule', async () => {
    const s = setup(mode);
    await expect(s.service.listPayoutReversalEntries(admin, 'b1', { outletId: 'O1', fieldId: 'f1' })).resolves.toEqual({
      mode: 'LEGACY',
      engineMode: mode,
      entries: [],
    });
    await expect(s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']))).rejects.toThrow(/not enabled/);

    const r = await s.service.createReversal(admin, 'b1', req(50_000));
    expect(s.allocs()).toHaveLength(0); // no reservation under LEGACY / SHADOW
    expect(r).not.toHaveProperty('payoutEntries');
    const done = (await approve(s, r.id)) as Row;
    expect(s.e('pe-b').status).toBe('REVERSED'); // interim exact-subset pick
    expect(s.reversal(r.id).consumedPayoutEntryIds).toEqual(['pe-b']);
    expect(s.allocs()).toHaveLength(0);
    expect(done.clawbackShortfall).toBe(0);
    // listReversals: a LEGACY reversal is returned exactly as stored (no payoutEntries key).
    const list = await s.service.listReversals(gifsy, {} as any);
    expect(list.reversals[0]).not.toHaveProperty('payoutEntries');
    // Owner decision 3: the outcome summary is returned on every tenant (display only).
    expect(done.payoutOutcome).toMatchObject({
      headline: 'Approved · 1 entry cancelled (₹500.00) — will not be paid',
      lines: [{ kind: 'CANCELLED', entryId: 'pe-b', text: 'Entry cancelled · ₹500.00 · will not be paid' }],
      receivablePaise: 0,
      tdsCreditPaise: 0,
    });
    const dl = await download(s);
    expect(dl.reversalHeld).toEqual([]);
    expect(dl.tdsCreditApplied).toEqual([]);
    expect(s.db.t('auditLog')).toHaveLength(0);
    expect(s.db.t('tdsCredit')).toHaveLength(0);
  });

  it('PAID entry with TDS withheld: receivable = NET received (shipped rule 7ba69566), no TDS credit — and said so', async () => {
    const s = setup(mode);
    Object.assign(s.e('pe-a'), { tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT', tdsDeductedPaise: 600n });
    s.db.t('tdsDeductionEntry').push({ id: 't2', creditPayoutEntryId: 'pe-a', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 600n, createdAt: new Date('2026-11-03') });
    const r = await s.service.createReversal(admin, 'b1', req(30_000));
    const done = (await approve(s, r.id)) as Row;
    expect(s.reversal(r.id).shortfallPaise).toBe(29_400n); // ₹300 paid − ₹6 TDS withheld
    expect(s.db.t('tdsCredit')).toHaveLength(0);
    expect(s.e('pe-a')).toMatchObject({ status: 'PAID', tdsDeductedPaise: 600n, tdsBaseReversedAt: null }); // LEGACY never marks
    expect(done.payoutOutcome.headline).toBe('Approved · ₹294.00 recorded as owed');
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Recorded as owed · ₹294.00 (paid ₹300.00 − TDS ₹6.00) · already paid — recover it off-platform · ' +
        "TDS ₹6.00 was withheld and stays deposited — no TDS credit on this program's reversal rules",
    );
  });

  it('PAID entry FULLY withheld as TDS: reversed, the withholding offset in its FY, nothing owed (shipped rule) — said so', async () => {
    const s = setup(mode);
    Object.assign(s.e('pe-a'), { tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT', tdsDeductedPaise: 30_000n, utr: 'TDS-WITHHELD-X' });
    s.db.t('tdsDeductionEntry').push({ id: 't3', clientId: TENANT, creditPayoutEntryId: 'pe-a', panNumber: 'ABCDE1234F', section: 'SEC_194R', fyLabel: '2026-27', tdsDeductedThisPaise: 30_000n, createdAt: new Date('2026-11-03') });
    const r = await s.service.createReversal(admin, 'b1', req(30_000));
    const done = (await approve(s, r.id)) as Row;
    expect(s.e('pe-a')).toMatchObject({ status: 'REVERSED', tdsDeductedPaise: 0n });
    expect(s.reversal(r.id).shortfallPaise).toBe(0n);
    const off = s.db.t('tdsDeductionEntry').find((x) => x.tdsDeductedThisPaise === -30_000n)!;
    expect(off).toMatchObject({ fyLabel: '2026-27', panNumber: 'ABCDE1234F', creditPayoutEntryId: 'pe-a' });
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Entry reversed · ₹300.00 · the whole payout had been withheld as TDS, nothing reached the retailer — nothing owed · ' +
        'withheld TDS ₹300.00 reversed in the TDS ledger',
    );
  });

  it('reject: says nothing was held or changed', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(50_000));
    const rj = (await reject(s, r.id)) as Row;
    expect(rj.payoutOutcome).toMatchObject({ headline: 'Rejected · no payout entry was held or changed', lines: [{ kind: 'NOTHING' }] });
    expect(s.e('pe-b').status).toBe('PENDING');
  });

  it('refuses payoutEntryIds on a POINTS reversal (any mode)', async () => {
    const s = setup('V2');
    s.wallet.creditedPointsForBatchRow.mockResolvedValue(1_000n);
    await expect(
      s.service.createReversal(admin, 'b1', { ...req(10, ['pe-b']), awardType: 'POINTS' as any }),
    ).rejects.toThrow(/PAYOUT reversals only/);
  });

  it('DTO: payoutEntryIds must be a non-empty unique string array', async () => {
    const bad = async (v: unknown) =>
      (await validate(plainToInstance(CreateReversalDto, { ...req(1), payoutEntryIds: v }))).length > 0;
    expect(await bad([])).toBe(true);
    expect(await bad(['a', 'a'])).toBe(true);
    expect(await bad([1])).toBe(true);
    expect(await bad(['a', 'b'])).toBe(false);
  });
});

// ─── V2 (SHADOW = LEGACY for payouts since 2026-11-16) ─────────────────────────────────────────────────────────
describe.each(['V2'] as const)('WP5 — %s tenant: entry-targeted PAYOUT reversals', (mode) => {
  it('candidates: every entry of the (batch, outlet, field) with why it can or cannot be picked', async () => {
    const s = setup(mode);
    s.db.t('creditPayoutEntry').push(entry('pe-x', 10_000n, 'REVERSED', { createdAt: new Date('2026-11-03T00:00:00Z') }));
    const res = await s.service.listPayoutReversalEntries(admin, 'b1', { outletId: 'O1', fieldId: 'f1' });
    expect(res.mode).toBe(mode);
    expect(res.entries.map((c) => [c.id, c.amountPaise, c.selectable, c.blockedBy])).toEqual([
      ['pe-a', 30_000, true, null],
      ['pe-b', 50_000, true, null],
      ['pe-x', 10_000, false, 'REVERSED'],
    ]);
  });

  it('T-pay2 exact subset: [₹300 PAID, ₹500 PENDING] — reversing the ₹500 entry is accepted and cancels it', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    expect(s.allocs(r.id)).toMatchObject([{ payoutEntryId: 'pe-b', amountPaise: 50_000n, state: 'RESERVED' }]);
    const done = (await approve(s, r.id)) as Row;
    expect(s.e('pe-b')).toMatchObject({ status: 'REVERSED', downloadId: null });
    expect(s.e('pe-a').status).toBe('PAID');
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_CANCELLED', tdsOffsetPaise: 0n }]);
    expect(s.reversal(r.id)).toMatchObject({ status: 'APPROVED', approvedPaise: 50_000n, shortfallPaise: 0n });
    expect(s.reversal(r.id).consumedPayoutEntryIds).toEqual(['pe-b']); // mirror for the interim selector
    expect(done.clawbackShortfall).toBe(0);
    expect(done.payoutOutcome).toEqual({
      headline: 'Approved · 1 entry cancelled (₹500.00) — will not be paid',
      lines: [{ kind: 'CANCELLED', entryId: 'pe-b', text: 'Entry cancelled · ₹500.00 · will not be paid' }],
      cancelled: [{ entryId: 'pe-b', amountPaise: 50_000, wasStatus: 'PENDING', tdsOffsetPaise: 0, tdsNote: 'no TDS withheld' }],
      receivable: [],
      receivablePaise: 0,
      tdsCreditPaise: 0,
      released: [],
    });
    // audit trail: reserve (CREATE) then apply (APPROVE), with the entries
    const audits = s.db.t('auditLog').filter((a) => a.entityId === r.id);
    expect(audits.map((a) => [a.action, a.entityType, a.actorId])).toEqual([
      ['CREATE', 'PAYOUT_REVERSAL_ALLOCATION', 'client-admin'],
      ['APPROVE', 'PAYOUT_REVERSAL_ALLOCATION', 'gifsy-admin'],
    ]);
    expect(audits[0].metadata).toMatchObject({ step: 'RESERVED', totalPaise: '50000', entries: [{ entryId: 'pe-b', amountPaise: '50000', status: 'PENDING' }] });
    expect(audits[1].metadata).toMatchObject({ step: 'APPLIED', cancelled: [{ entryId: 'pe-b' }], receivablePaise: 0 });
  });

  it('T-pay1 double consumption: a PAID entry becomes a receivable ONCE and is unreachable to a later reversal', async () => {
    const s = setup(mode);
    const r1 = await s.service.createReversal(admin, 'b1', req(30_000, ['pe-a']));
    const d1 = (await approve(s, r1.id)) as Row;
    expect(s.e('pe-a').status).toBe('PAID'); // Q11: entry stays PAID
    expect(s.allocs(r1.id)).toMatchObject([{ state: 'APPLIED_RECEIVABLE' }]);
    expect(s.reversal(r1.id).shortfallPaise).toBe(30_000n);
    expect(d1.clawbackShortfall).toBe(30_000);
    expect(d1.payoutOutcome).toMatchObject({
      headline: 'Approved · ₹300.00 recorded as owed',
      receivable: [{ entryId: 'pe-a', amountPaise: 30_000, receivablePaise: 30_000, tdsCreditPaise: 0 }],
      receivablePaise: 0 + 30_000,
      lines: [{ kind: 'RECEIVABLE', text: 'Recorded as owed · ₹300.00 · no TDS withheld — no TDS credit' }],
    });

    await expect(s.service.createReversal(admin, 'b1', req(30_000, ['pe-a']))).rejects.toThrow(/already taken/);
    const c = await s.service.listPayoutReversalEntries(admin, 'b1', { outletId: 'O1', fieldId: 'f1' });
    expect(c.entries.find((x) => x.id === 'pe-a')).toMatchObject({ selectable: false, blockedBy: 'CONSUMED' });
    // …and if the tenant is switched back to LEGACY, the interim selector sees it as consumed too.
    s.settings.mode = 'LEGACY';
    await expect(s.service.createReversal(admin, 'b1', req(30_000))).rejects.toThrow(/whole payout entries/);
    // The live-allocation index holds exactly one row for the entry.
    expect(s.allocs().filter((a) => a.payoutEntryId === 'pe-a' && LIVE.includes(a.state))).toHaveLength(1);
  });

  it('P1: the request must equal the selected entries, which must belong to this outlet + field', async () => {
    const s = setup(mode);
    await expect(s.service.createReversal(admin, 'b1', req(50_000))).rejects.toThrow(/Select the payout entries/);
    await expect(s.service.createReversal(admin, 'b1', req(40_000, ['pe-b']))).rejects.toThrow(/must equal the selected/);
    await expect(s.service.createReversal(admin, 'b1', req(20_000, ['pe-c']))).rejects.toThrow(/not an entry of this outlet/);
    await expect(s.service.createReversal(admin, 'b1', req(80_000, ['pe-a', 'pe-b']))).resolves.toBeDefined();
    expect(s.allocs().map((a) => a.payoutEntryId).sort()).toEqual(['pe-a', 'pe-b']);
    // nothing was written by the refused attempts (rolled back)
    expect(s.db.t('creditReversal')).toHaveLength(1);
  });

  it('P2: an entry held by a pending reversal cannot be selected again; a rejection releases it', async () => {
    const s = setup(mode);
    // Only one pending reversal can exist per (batch, outlet, field), so the hold is proven via the candidates view
    // (the index backstop has its own test below), then released by a rejection.
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    const c = await s.service.listPayoutReversalEntries(admin, 'b1', { outletId: 'O1', fieldId: 'f1' });
    expect(c.entries.find((x) => x.id === 'pe-b')).toMatchObject({ selectable: false, blockedBy: 'RESERVED' });
    const rj = (await reject(s, r.id)) as Row;
    expect(rj.payoutOutcome).toMatchObject({ released: [{ entryId: 'pe-b', amountPaise: 50_000 }] });
    expect(rj.payoutClawbackNote).toMatch(/released — eligible for the next bank file/);
    expect(s.db.t('auditLog').find((a) => a.action === 'REJECT')).toMatchObject({ entityId: r.id, metadata: { step: 'RELEASED' } });
    expect(s.reversal(r.id).status).toBe('REJECTED');
    expect(s.allocs(r.id)).toMatchObject([{ state: 'RELEASED' }]);
    expect(s.e('pe-b').status).toBe('PENDING');
    const r2 = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    expect(s.allocs(r2.id)).toMatchObject([{ state: 'RESERVED' }]);
  });

  it('T-pay3 reservation vs download: a RESERVED entry is skipped by the bank file and re-enters it after a rejection', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    const d1 = await download(s);
    expect(s.e('pe-c')).toMatchObject({ status: 'PROCESSING', downloadId: d1.downloadId });
    expect(s.e('pe-b')).toMatchObject({ status: 'PENDING', downloadId: null }); // held out of the file
    // …and reported, never silent: returned to the screen + an audit row on the download.
    expect(d1.reversalHeld).toEqual([
      { entryId: 'pe-b', outletId: 'O1', outletName: 'Outlet One', fieldName: 'Volume', amountPaise: 50_000, status: 'PENDING', creditReversalId: r.id },
    ]);
    expect(s.db.t('auditLog').find((a) => a.entityType === 'PAYOUT_DOWNLOAD_REVERSAL_HOLD')).toMatchObject({
      entityId: d1.downloadId, action: 'EXPORT', metadata: { heldCount: 1, heldPaise: '50000' },
    });
    // a file with nothing else payable says why
    s.e('pe-c').status = 'PAID';
    await expect(download(s)).rejects.toThrow(/1 entry \(₹500\.00\) is held out of bank files because a reversal request is pending/);
    s.e('pe-c').status = 'PROCESSING';
    await reject(s, r.id);
    const d2 = await download(s);
    expect(d2.reversalHeld).toEqual([]);
    expect(s.e('pe-b')).toMatchObject({ status: 'PROCESSING', downloadId: d2.downloadId });
  });

  it('T-pay3 race: a reservation committed between the download read and its claim rolls the download back', async () => {
    const s = setup(mode);
    let fired = false;
    s.db.onDownloadCreate = () => {
      if (fired) return;
      fired = true; // the reversal tx commits here (between the read and the claim)
      s.db.t('payoutReversalAllocation').push({
        id: 'al-race', creditReversalId: 'rev-race', payoutEntryId: 'pe-b', amountPaise: 50_000n, state: 'RESERVED', tdsOffsetPaise: 0n,
      });
    };
    await expect(download(s)).rejects.toBeInstanceOf(ConflictException);
    // rolled back: nothing claimed, no download row, the reservation (committed by the other tx) is intact
    expect(s.e('pe-b')).toMatchObject({ status: 'PENDING', downloadId: null });
    expect(s.e('pe-c')).toMatchObject({ status: 'PENDING', downloadId: null });
    expect(s.db.t('creditPayoutDownload')).toHaveLength(0);
    // simulate the other tx's commit surviving our rollback, then the retry skips the reserved entry
    s.db.t('payoutReversalAllocation').push({
      id: 'al-race', creditReversalId: 'rev-race', payoutEntryId: 'pe-b', amountPaise: 50_000n, state: 'RESERVED', tdsOffsetPaise: 0n,
    });
    await download(s);
    expect(s.e('pe-b').status).toBe('PENDING');
    expect(s.e('pe-c').status).toBe('PROCESSING');
  });

  it('T-pay4 PROCESSING: reservable, but approval is refused (nothing changes) until the bank result is recorded', async () => {
    const s = setup(mode);
    s.e('pe-b').status = 'PROCESSING';
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    await expect(approve(s, r.id)).rejects.toThrow(/already sent to the bank/);
    expect(s.reversal(r.id).status).toBe('PENDING_GIFSY');
    expect(s.allocs(r.id)).toMatchObject([{ state: 'RESERVED' }]);
    expect(s.e('pe-b').status).toBe('PROCESSING');
    // UTR upload records a bank failure → FAILED; the RESERVED hold keeps it out of the re-bank, approval now cancels it.
    Object.assign(s.e('pe-b'), { status: 'FAILED' });
    await download(s); // re-bank run: pe-c only
    expect(s.e('pe-b').status).toBe('FAILED');
    await approve(s, r.id);
    expect(s.e('pe-b').status).toBe('REVERSED');
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_CANCELLED' }]);
  });

  it('T-pay5 TDS offset: an unpaid entry’s withholding is offset ONCE; a PAID 194R entry gets none (receivable + credit); 194C PAID is refused (D1)', async () => {
    const s = setup(mode);
    s.settings.resolveTdsPolicy.mockImplementation(async () => ({ section: 'SEC_194R', methodology: 'DEDUCT' })); // A5
    Object.assign(s.e('pe-b'), { status: 'FAILED', tdsSection: 'SEC_194C', tdsDeductedPaise: 1_000n });
    Object.assign(s.e('pe-a'), { tdsSection: 'SEC_194R', tdsDeductedPaise: 600n });
    s.db.t('tdsDeductionEntry').push(
      { id: 't1', clientId: TENANT, section: 'SEC_194C', fyLabel: '2026-27', creditPayoutEntryId: 'pe-b', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 1_000n, createdAt: new Date('2026-11-03') },
      { id: 't2', clientId: TENANT, section: 'SEC_194R', fyLabel: '2026-27', creditPayoutEntryId: 'pe-a', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 600n, createdAt: new Date('2026-11-03') },
    );
    const r = await s.service.createReversal(admin, 'b1', req(80_000, ['pe-a', 'pe-b']));
    await approve(s, r.id);
    const ledger = (id: string) =>
      s.db.t('tdsDeductionEntry').filter((t) => t.creditPayoutEntryId === id).reduce((n, t) => n + t.tdsDeductedThisPaise, 0n);
    expect(ledger('pe-b')).toBe(0n); // offset exactly once
    expect(s.db.t('tdsDeductionEntry').filter((t) => t.tdsDeductedThisPaise < 0n)).toHaveLength(1);
    expect(s.e('pe-b')).toMatchObject({ status: 'REVERSED', tdsDeductedPaise: 0n });
    expect(ledger('pe-a')).toBe(600n); // PAID → no offset (the TDS stays deposited → a TDS credit, round B)
    expect(s.allocs(r.id).find((a) => a.payoutEntryId === 'pe-b')).toMatchObject({ state: 'APPLIED_CANCELLED', tdsOffsetPaise: 1_000n });
    expect(s.allocs(r.id).find((a) => a.payoutEntryId === 'pe-a')).toMatchObject({
      state: 'APPLIED_RECEIVABLE', tdsOffsetPaise: 0n, receivablePaise: 29_400n, tdsCreditPaise: 600n,
    });
    expect(s.reversal(r.id).shortfallPaise).toBe(29_400n); // net cash received (owner decision 2)
  });

  it('T-pay5 call-outs: the approval result names each TDS outcome (offset / not reversed on a paid entry)', async () => {
    const s = setup(mode);
    Object.assign(s.e('pe-b'), { status: 'FAILED', tdsSection: 'SEC_194C', tdsDeductedPaise: 1_000n });
    Object.assign(s.e('pe-a'), { tdsSection: 'SEC_194R', tdsDeductedPaise: 600n });
    s.db.t('tdsDeductionEntry').push({ id: 't1', creditPayoutEntryId: 'pe-b', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 1_000n, createdAt: new Date('2026-11-03') });
    const r = await s.service.createReversal(admin, 'b1', req(80_000, ['pe-a', 'pe-b']));
    const done = (await approve(s, r.id)) as Row;
    expect(done.payoutOutcome.cancelled[0].tdsNote).toMatch(/withheld TDS ₹10\.00 offset in the TDS ledger/);
    // pe-a's ₹6 stamp has no TDS-ledger row → net receivable, no credit, and it is called out.
    expect(done.payoutOutcome.receivable[0]).toMatchObject({ receivablePaise: 29_400, tdsCreditPaise: 0 });
    expect(done.payoutOutcome.receivable[0].tdsNote).toMatch(/₹6\.00 TDS on this entry is not in Gifsy's TDS ledger/);
    expect(done.payoutOutcome.lines.find((l: Row) => l.kind === 'RECEIVABLE').text).toMatch(
      /Recorded as owed · ₹294\.00 \(net of ₹6\.00 TDS withheld from ₹300\.00\) · no TDS credit · ₹6\.00 TDS not in Gifsy's TDS ledger — correct it off-platform/,
    );
    expect(done.payoutOutcome.lines.find((l: Row) => l.kind === 'CANCELLED').text).toBe(
      'Entry cancelled · ₹500.00 · will not be paid (the bank payment had failed) · withheld TDS ₹10.00 reversed in the TDS ledger',
    );
  });

  it('T-pay5 already offset (ledger net 0, stamp left) → no second offset row', async () => {
    const s = setup(mode);
    Object.assign(s.e('pe-b'), { status: 'FAILED', tdsSection: 'SEC_194C', tdsDeductedPaise: 1_000n });
    s.db.t('tdsDeductionEntry').push(
      { id: 't1', creditPayoutEntryId: 'pe-b', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 1_000n, createdAt: new Date('2026-11-03') },
      { id: 't2', creditPayoutEntryId: 'pe-b', panNumber: 'ABCDE1234F', tdsDeductedThisPaise: -1_000n, createdAt: new Date('2026-11-04') },
    );
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    await approve(s, r.id);
    expect(s.db.t('tdsDeductionEntry')).toHaveLength(2);
    expect(s.allocs(r.id)).toMatchObject([{ tdsOffsetPaise: 0n }]);
  });

  it('approve is whole-or-nothing and locks the entries in ascending id order', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(80_000, ['pe-b', 'pe-a']));
    await expect(
      s.service.patchReversal(gifsy, r.id, { action: ReversalAction.approve, approvedPaise: 50_000 }),
    ).rejects.toThrow(/approved in full or rejected/);
    s.db.rawCalls = [];
    await approve(s, r.id);
    const lock = s.db.rawCalls.find((c) => c.sql.includes('credit_payout_entries') && c.sql.includes('FOR UPDATE'))!;
    expect((lock.values[1] as Prisma.Sql).values).toEqual(['pe-a', 'pe-b']);
    const batchLockIdx = s.db.rawCalls.findIndex((c) => c.sql.includes('credit_batches'));
    expect(batchLockIdx).toBeGreaterThanOrEqual(0);
    expect(batchLockIdx).toBeLessThan(s.db.rawCalls.indexOf(lock)); // credit_batches → credit_payout_entries
  });

  it('a second approval of the same reversal is refused and changes nothing', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(30_000, ['pe-a']));
    await approve(s, r.id);
    await expect(approve(s, r.id)).rejects.toThrow(/already APPROVED/);
    expect(s.reversal(r.id).shortfallPaise).toBe(30_000n);
    expect(s.allocs()).toHaveLength(1);
  });

  it('listReversals shows the held entries of an engine reversal (only)', async () => {
    const s = setup(mode);
    const r = await s.service.createReversal(admin, 'b1', req(80_000, ['pe-a', 'pe-b']));
    const list = await s.service.listReversals(gifsy, {} as any);
    const got = list.reversals.find((x) => x.id === r.id) as Row;
    expect(got.payoutEntries).toEqual([
      expect.objectContaining({ payoutEntryId: 'pe-a', amountPaise: 30_000, allocationState: 'RESERVED', entryStatus: 'PAID' }),
      expect.objectContaining({ payoutEntryId: 'pe-b', amountPaise: 50_000, allocationState: 'RESERVED', entryStatus: 'PENDING' }),
    ]);
  });
});

describe('WP5 — engine reversal approved after the flag goes back to LEGACY', () => {
  it('is decided by its allocation rows, not the flag: approval still applies the reservation', async () => {
    const s = setup('V2');
    const r = await s.service.createReversal(admin, 'b1', req(30_000, ['pe-a']));
    s.settings.mode = 'LEGACY';
    await approve(s, r.id);
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_RECEIVABLE' }]);
    expect(s.reversal(r.id).shortfallPaise).toBe(30_000n);
  });
});

describe('WP5 — partial unique index backstop', () => {
  it('reservePayoutEntries maps the live-allocation unique violation to a clean 400', async () => {
    const db = new FakeDb();
    db.t('payoutReversalAllocation').push({ id: 'x', creditReversalId: 'r0', payoutEntryId: 'pe-b', amountPaise: 1n, state: 'RESERVED', tdsOffsetPaise: 0n });
    await expect(
      reservePayoutEntries(db.client(), 'r1', [{ id: 'pe-b', amountPaise: 1n, status: 'PENDING' }], {
        clientId: TENANT, batchId: 'b1', outletId: 'O1', fieldId: 'f1', actorId: 'u',
      }),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ─── Pure functions ────────────────────────────────────────────────────────────────────────────────────────────
describe('classifyPayoutCandidates (pure)', () => {
  const E = (id: string, status: string, amount = 100n, created = '2026-11-01') => ({
    id, amountPaise: amount, status, period: '2026-10', createdAt: new Date(created), tdsDeductedPaise: 0n, tdsSection: null, outletId: 'O1',
  });
  it('blocks REVERSED, RESERVED, CONSUMED (allocation / consumed ids / pre-column cutoff), ZERO', () => {
    const out = classifyPayoutCandidates(
      [E('a', 'REVERSED'), E('b', 'PENDING'), E('c', 'PAID'), E('d', 'PAID'), E('e', 'PAID', 100n, '2026-11-01'), E('f', 'PAID', 100n, '2026-12-01'), E('g', 'PENDING', 0n), E('h', 'FAILED')],
      [
        { payoutEntryId: 'b', creditReversalId: 'r1', state: 'RESERVED' },
        { payoutEntryId: 'c', creditReversalId: 'r2', state: 'APPLIED_RECEIVABLE' },
        { payoutEntryId: 'h', creditReversalId: 'r3', state: 'RELEASED' }, // released → free
      ],
      [
        { consumedPayoutEntryIds: ['d'], approvedAt: new Date('2026-11-05'), approvedPaise: 100n },
        { consumedPayoutEntryIds: null, approvedAt: new Date('2026-11-10'), approvedPaise: 100n }, // pre-column
      ],
    );
    expect(out.map((c) => [c.id, c.blockedBy])).toEqual([
      ['a', 'REVERSED'], ['b', 'RESERVED'], ['c', 'CONSUMED'], ['d', 'CONSUMED'], ['e', 'CONSUMED'], ['f', null], ['g', 'ZERO'], ['h', null],
    ]);
    expect(out.find((c) => c.id === 'b')!.heldByReversalId).toBe('r1');
  });
});

describe('planPayoutAllocationBackfill (pure)', () => {
  const R = (id: string, o: Partial<BackfillPayoutReversal>): BackfillPayoutReversal => ({
    id, clientId: TENANT, batchId: 'b1', outletId: 'O1', fieldId: 'f1', status: 'APPROVED', awardType: 'PAYOUT',
    approvedPaise: 0n, shortfallPaise: 0n, approvedAt: new Date('2026-11-10'), consumedPayoutEntryIds: null, ...o,
  });
  const E = (id: string, amount: bigint, status: string, created = '2026-11-01', o: Partial<BackfillPayoutEntry> = {}): BackfillPayoutEntry => ({
    id, clientId: TENANT, batchId: 'b1', outletId: 'O1', fieldId: 'f1', amountPaise: amount, status, createdAt: new Date(created), ...o,
  });

  it('consumed ids → APPLIED_CANCELLED / APPLIED_RECEIVABLE with the booked TDS offset', () => {
    const plan = planPayoutAllocationBackfill({
      reversals: [R('r1', { approvedPaise: 800n, shortfallPaise: 300n, consumedPayoutEntryIds: ['a', 'b'] })],
      entries: [E('a', 300n, 'PAID'), E('b', 500n, 'REVERSED')],
      existingAllocations: [],
      tdsOffsetByEntry: new Map([['b', 20n]]),
    });
    expect(plan.flags).toEqual([]);
    expect(plan.allocations).toEqual([
      { creditReversalId: 'r1', payoutEntryId: 'a', amountPaise: 300n, state: 'APPLIED_RECEIVABLE', tdsOffsetPaise: 0n, receivablePaise: 300n, tdsCreditPaise: 0n },
      { creditReversalId: 'r1', payoutEntryId: 'b', amountPaise: 500n, state: 'APPLIED_CANCELLED', tdsOffsetPaise: 20n, receivablePaise: 0n, tdsCreditPaise: 0n },
    ]);
  });

  it('audit B2: a PAID entry with TDS withheld records the NET receivable (amount − TDS withheld), as prod 7ba69566 approves it', () => {
    const plan = planPayoutAllocationBackfill({
      reversals: [R('r1', { approvedPaise: 300n, shortfallPaise: 294n, consumedPayoutEntryIds: ['a'] })],
      entries: [E('a', 300n, 'PAID', '2026-11-01', { tdsDeductedPaise: 6n })],
      existingAllocations: [],
    });
    expect(plan.flags).toEqual([]); // shortfall 294 = net → no SHORTFALL_MISMATCH
    expect(plan.allocations).toEqual([
      { creditReversalId: 'r1', payoutEntryId: 'a', amountPaise: 300n, state: 'APPLIED_RECEIVABLE', tdsOffsetPaise: 0n, receivablePaise: 294n, tdsCreditPaise: 0n },
    ]);
    // an approval from before 7ba69566 recorded the GROSS amount → flagged (WARNING), the row still records the net
    const old = planPayoutAllocationBackfill({
      reversals: [R('r2', { approvedPaise: 300n, shortfallPaise: 300n, consumedPayoutEntryIds: ['a'] })],
      entries: [E('a', 300n, 'PAID', '2026-11-01', { tdsDeductedPaise: 6n })],
      existingAllocations: [],
    });
    expect(old.flags.map((f) => [f.code, f.severity])).toEqual([['SHORTFALL_MISMATCH', 'WARNING']]);
  });

  it('flags double consumption (first approved wins), a missing / unsettled entry and an amount mismatch — no rows for them', () => {
    const plan = planPayoutAllocationBackfill({
      reversals: [
        R('r2', { approvedPaise: 300n, shortfallPaise: 300n, consumedPayoutEntryIds: ['a'], approvedAt: new Date('2026-11-12') }),
        R('r1', { approvedPaise: 300n, shortfallPaise: 300n, consumedPayoutEntryIds: ['a'], approvedAt: new Date('2026-11-11') }),
        R('r3', { approvedPaise: 100n, consumedPayoutEntryIds: ['zz'] }),
        R('r4', { approvedPaise: 500n, consumedPayoutEntryIds: ['p'] }),
        R('r5', { approvedPaise: 999n, consumedPayoutEntryIds: ['c'] }),
      ],
      entries: [E('a', 300n, 'PAID'), E('p', 500n, 'PENDING'), E('c', 100n, 'REVERSED')],
      existingAllocations: [],
    });
    expect(plan.allocations.map((a) => a.creditReversalId)).toEqual(['r1']);
    expect(plan.flags.map((f) => [f.creditReversalId, f.code, f.severity])).toEqual([
      ['r3', 'ENTRY_MISSING', 'BLOCKING'],
      ['r4', 'ENTRY_NOT_SETTLED', 'BLOCKING'],
      ['r5', 'AMOUNT_MISMATCH', 'BLOCKING'],
      ['r2', 'DOUBLE_CONSUMPTION', 'BLOCKING'],
    ]);
  });

  it('pre-column approvals: derived when all / exactly one subset of settled entries fits, ambiguous otherwise', () => {
    const plan = planPayoutAllocationBackfill({
      reversals: [
        R('all', { approvedPaise: 800n, shortfallPaise: 300n, outletId: 'O1' }),
        R('uniq', { approvedPaise: 500n, outletId: 'O2' }),
        R('amb', { approvedPaise: 500n, outletId: 'O3' }),
        R('none', { approvedPaise: 700n, outletId: 'O4' }),
      ],
      entries: [
        E('a', 300n, 'PAID'), E('b', 500n, 'REVERSED'),
        E('c', 300n, 'PAID', '2026-11-01', { outletId: 'O2' }), E('d', 500n, 'REVERSED', '2026-11-01', { outletId: 'O2' }),
        E('late', 999n, 'REVERSED', '2026-12-01', { outletId: 'O2' }), // created after the approval → never a candidate
        E('e', 250n, 'REVERSED', '2026-11-01', { outletId: 'O3' }), E('f', 250n, 'REVERSED', '2026-11-01', { outletId: 'O3' }), E('g', 250n, 'PAID', '2026-11-01', { outletId: 'O3' }),
        E('h', 300n, 'REVERSED', '2026-11-01', { outletId: 'O4' }),
      ],
      existingAllocations: [],
    });
    expect(plan.allocations.map((a) => `${a.creditReversalId}:${a.payoutEntryId}`)).toEqual(['all:a', 'all:b', 'uniq:d']);
    expect(plan.flags.map((f) => [f.creditReversalId, f.code])).toEqual([
      ['all', 'DERIVED_LEGACY'],
      ['amb', 'AMBIGUOUS_LEGACY'],
      ['none', 'AMBIGUOUS_LEGACY'],
      ['uniq', 'DERIVED_LEGACY'],
    ]);
  });

  it('skips reversals that already have rows (re-run = no-op), flags pending ones, ignores rejected / POINTS, warns on a shortfall mismatch', () => {
    const plan = planPayoutAllocationBackfill({
      reversals: [
        R('done', { approvedPaise: 300n, consumedPayoutEntryIds: ['a'] }),
        R('pend', { status: 'PENDING_GIFSY', approvedAt: null }),
        R('rej', { status: 'REJECTED' }),
        R('pts', { awardType: 'POINTS', approvedPaise: 5n }),
        R('sf', { approvedPaise: 500n, shortfallPaise: 0n, consumedPayoutEntryIds: ['b'] }),
      ],
      entries: [E('a', 300n, 'PAID'), E('b', 500n, 'PAID')],
      existingAllocations: [{ creditReversalId: 'done', payoutEntryId: 'a', state: 'APPLIED_RECEIVABLE' }],
    });
    expect(plan.allocations.map((a) => a.creditReversalId)).toEqual(['sf']);
    expect(plan.flags.map((f) => [f.creditReversalId, f.code, f.severity])).toEqual([
      ['sf', 'SHORTFALL_MISMATCH', 'WARNING'],
      ['pend', 'PENDING_LEGACY', 'INFO'],
    ]);
  });
});

// ─── Policy round B (owner 2026-11-16): net receivable + TDS credit carried forward on the PAN ─────────────────
// WALLET-REVERSAL-ENGINE-DESIGN.md §8.1. Full service paths against the fake: V2 approve → credit; the next bank
// download (visibility DEDUCT engine, 194C individual 1%, single-payment threshold ₹30,000) → credit applied.
const PAN = 'ABCDE1234F';
const FY = '2026-27';

/**
 * Owner D1 (2026-11-19): a PAID 194C payout can't be reversed, so the TDS-credit path is 194R only. This fixture is
 * 194R on the SHIPPED whole-year definition: the client's CURRENT method is DEDUCT (only then is 194R visibility
 * withheld and — audit A5 — only then is a credit created), the PAID payouts went through a bank file made in FY
 * 2026-27, 10% with a PAN, ₹20,000 FY limit.
 */
function visSetup() {
  const s = setup('V2');
  const db = s.db;
  db.t('creditField').push({ id: 'fv', clientId: TENANT, payoutStream: 'VISIBILITY', isActive: true });
  const batch = (id: string, amount: number) =>
    db.t('creditBatch').push({
      id, clientId: TENANT, batchCode: `CB-${id}`, period: '2026-10', status: 'CONFIRMED',
      rows: [{ outletId: 'O1', fieldId: 'fv', awardType: 'PAYOUT', status: 'OK', amount }],
    });
  batch('b2', 4_000_000);
  batch('b3', 5_000_000);
  batch('b4', 1_000_000);
  const o1 = db.t('outlet').find((o) => o.outletCode === 'O1')!;
  o1.partnerId = 'p1';
  Object.assign(o1.partner, { panNumber: PAN, entityType: 'INDIVIDUAL' });
  db.t('channelPartner').push({ id: 'p1', clientId: TENANT, panNumber: PAN, isParent: false, entityType: 'INDIVIDUAL' });
  s.settings.resolveTdsPolicy.mockImplementation(async () => ({ section: 'SEC_194R', methodology: 'DEDUCT' }));
  db.t('creditPayoutDownload').push({ id: 'dl-old', clientId: TENANT, downloadCode: 'OLD', downloadedAt: new Date('2026-11-01T06:00:00Z') });
  const vis = (id: string, batchId: string, amountPaise: bigint, status: string, extra: Row = {}) =>
    entry(id, amountPaise, status, {
      batchId, fieldId: 'fv', fieldName: 'Visibility', tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT', ...extra,
    });
  const led = (entryId: string, paise: bigint, clientId = TENANT) =>
    db.t('tdsDeductionEntry').push({
      id: `led-${entryId}-${db.t('tdsDeductionEntry').length}`, clientId, panNumber: PAN, section: 'SEC_194R', fyLabel: FY,
      creditPayoutEntryId: entryId, tdsDeductedThisPaise: paise, createdAt: new Date('2026-11-01'),
    });
  // va: ₹40,000 PAID (year ₹40,000 > ₹20,000) with ₹4,000 (10%) withheld + booked in the TDS ledger under the PAN.
  db.t('creditPayoutEntry').push(vis('va', 'b2', 4_000_000n, 'PAID', { tdsDeductedPaise: 400_000n }));
  led('va', 400_000n);
  const visDownload = () =>
    s.service.createPayoutDownload(gifsy, { period: '2026-10', groupType: PayoutGroupType.SEPARATE, fieldId: 'fv', fieldName: 'Visibility' });
  const reverse = async (batchId: string, ids: string[], amount: number) => {
    const r = await s.service.createReversal(admin, batchId, { ...req(amount, ids), originalPaise: amount, fieldId: 'fv', fieldName: 'Visibility' });
    return { r, done: (await approve(s, r.id)) as Row };
  };
  const credit = () => db.t('tdsCredit');
  const apps = () => db.t('tdsCreditApplication');
  const ledgerSum = () => db.t('tdsDeductionEntry').reduce((n: bigint, t) => n + (t.tdsDeductedThisPaise as bigint), 0n);
  const r194Locked = () =>
    s.db.execCalls.some(
      (c) => c.sql.includes('pg_advisory_xact_lock') && Array.isArray(c.values[0]) && (c.values[0] as string[]).includes(`R194|${TENANT}|${FY}`),
    );
  return { ...s, vis, led, visDownload, reverse, credit, apps, ledgerSum, r194Locked };
}

describe('Policy round B — reversing a PAID 194R payout whose TDS was DEDUCTED (V2)', () => {
  it('receivable = net received (₹36,000 of ₹40,000); ₹4,000 becomes a TDS credit; said so; R194 client+FY lock taken', async () => {
    const s = visSetup();
    const { r, done } = await s.reverse('b2', ['va'], 4_000_000);
    expect(s.e('va')).toMatchObject({ status: 'PAID', tdsDeductedPaise: 400_000n }); // entry untouched
    expect(s.reversal(r.id).shortfallPaise).toBe(3_600_000n);
    expect(done.clawbackShortfall).toBe(3_600_000);
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_RECEIVABLE', receivablePaise: 3_600_000n, tdsCreditPaise: 400_000n }]);
    expect(s.credit()).toMatchObject([
      {
        clientId: TENANT, panNumber: PAN, section: 'SEC_194R', fyLabel: FY, sourcePayoutEntryId: 'va', creditReversalId: r.id,
        amountPaise: 400_000n, appliedPaise: 0n, createdBy: 'gifsy-admin',
      },
    ]);
    expect(done.payoutOutcome.headline).toBe('Approved · ₹36,000.00 recorded as owed · ₹4,000.00 TDS credit carried forward');
    expect(done.payoutOutcome.lines).toEqual([
      {
        kind: 'RECEIVABLE',
        entryId: 'va',
        text:
          'Recorded as owed · ₹36,000.00 (net of ₹4,000.00 TDS withheld from ₹40,000.00) · ₹4,000.00 TDS credit carried forward on PAN XXXXX1234F · ' +
          'PAN XXXXX1234F now below the TDS threshold',
      },
    ]);
    expect(done.payoutOutcome.receivable[0].tdsNote).toMatch(
      /₹4,000\.00 TDS credit carried forward on PAN XXXXX1234F \(of ₹4,000\.00 withheld from this payout\)/,
    );
    // A2: the note cites the 194R base of the bank-file FY
    expect(done.payoutOutcome.receivable[0].tdsNote).toMatch(/taken off PAN XXXXX1234F's FY 2026-27 194R base \(the FY of its bank file\)/);
    expect(s.ledgerSum()).toBe(400_000n); // the TDS stays deposited — the ledger is NOT touched
    expect(s.e('va').tdsBaseReversedAt).toBeInstanceOf(Date); // D1: off the yearly base
    expect(s.e('va').tdsBaseReversalId).toBe(r.id);
    expect(s.r194Locked()).toBe(true);
    expect(s.db.t('auditLog').find((a) => a.action === 'APPROVE')!.metadata).toMatchObject({
      tdsCreditPaise: 400_000, receivablePaise: 3_600_000,
    });
  });

  it('idempotent: a second approval is refused and no second credit exists (unique per source entry)', async () => {
    const s = visSetup();
    const { r } = await s.reverse('b2', ['va'], 4_000_000);
    await expect(approve(s, r.id)).rejects.toThrow(/already APPROVED/);
    expect(s.credit()).toHaveLength(1);
  });

  it('GROSS_UP (nothing withheld): receivable = amount paid, no credit — and it says the program paid the TDS on top', async () => {
    const s = visSetup();
    Object.assign(s.e('va'), { tdsMethodology: 'GROSS_UP', tdsDeductedPaise: 0n });
    s.db.tables.tdsDeductionEntry = [];
    const { r, done } = await s.reverse('b2', ['va'], 4_000_000);
    expect(s.reversal(r.id).shortfallPaise).toBe(4_000_000n);
    expect(s.credit()).toHaveLength(0);
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Recorded as owed · ₹40,000.00 · no TDS was withheld from the retailer (the program paid it on top) — no TDS credit · ' +
        'PAN XXXXX1234F now below the TDS threshold',
    );
  });

  it('A5: the client is on GROSS_UP now → no credit (it could never be used); the withheld TDS stays the flagged excess — said so', async () => {
    const s = visSetup();
    s.settings.resolveTdsPolicy.mockImplementation(async () => ({ section: 'SEC_194R', methodology: 'GROSS_UP' }));
    const { r, done } = await s.reverse('b2', ['va'], 4_000_000);
    expect(s.credit()).toHaveLength(0);
    expect(s.reversal(r.id).shortfallPaise).toBe(3_600_000n);
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_RECEIVABLE', tdsCreditPaise: 0n }]);
    expect(done.payoutOutcome.lines[0].text).toContain(
      '₹4,000.00 withheld TDS not credited — the programme is on gross-up now; flagged as TDS taken in excess on the 194R report',
    );
    expect(done.payoutOutcome.receivable[0].tdsNote).toMatch(/stays on the 194R report as TDS taken in excess/);
  });

  it('next payout: TDS due ₹5,000, ₹4,000 adjusted from the credit, only ₹1,000 withheld — file, entry, ledger, audit, notice', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 5_000_000n, 'PENDING'));
    const dl = await s.visDownload();
    expect(s.e('vb')).toMatchObject({ status: 'PROCESSING', tdsDeductedPaise: 100_000n });
    expect(dl.tdsCreditApplied).toEqual([
      {
        entryId: 'vb', outletId: 'O1', outletName: 'Outlet One', duePaise: 500_000, creditPaise: 400_000, otherProgrammePaise: 0,
        withheldPaise: 100_000, panMasked: 'XXXXX1234F',
        note: 'TDS due ₹5,000.00 · ₹4,000.00 adjusted from earlier TDS credit · ₹1,000.00 withheld from this payout',
      },
    ]);
    expect(s.credit()[0].appliedPaise).toBe(400_000n);
    expect(s.apps()).toMatchObject([{ payoutEntryId: 'vb', amountPaise: 400_000n, downloadId: dl.downloadId, releasedAt: null }]);
    // the ledger records the NEW cash withheld; Σ deposited (₹4,000 + ₹1,000) = 10% of the income still standing (₹50,000)
    expect(s.ledgerSum()).toBe(500_000n);
    expect(s.db.t('creditPayoutDownload').find((d) => d.id !== 'dl-old')!.totalAmountPaise).toBe(4_900_000n);
    expect(s.db.t('auditLog').find((a) => a.entityType === 'TDS_CREDIT_APPLIED')).toMatchObject({ entityId: dl.downloadId, action: 'EXPORT' });
  });

  it('partial use + carry forward: ₹3,100 due → all from credit (₹900 left); next ₹1,000 due → ₹900 credit + ₹100 withheld', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 3_100_000n, 'PENDING'));
    const d1 = await s.visDownload();
    expect(s.e('vb').tdsDeductedPaise).toBe(0n);
    expect(d1.tdsCreditApplied[0]).toMatchObject({ duePaise: 310_000, creditPaise: 310_000, withheldPaise: 0 });
    expect(s.credit()[0].appliedPaise).toBe(310_000n); // ₹900 carried forward
    Object.assign(s.e('vb'), { status: 'PAID' }); // UTR recorded
    s.db.t('creditPayoutEntry').push(s.vis('vc', 'b4', 1_000_000n, 'PENDING'));
    const d2 = await s.visDownload();
    expect(d2.tdsCreditApplied[0]).toMatchObject({ entryId: 'vc', duePaise: 100_000, creditPaise: 90_000, withheldPaise: 10_000 });
    expect(s.e('vc').tdsDeductedPaise).toBe(10_000n);
    expect(s.credit()[0].appliedPaise).toBe(400_000n); // fully used
    expect(s.ledgerSum()).toBe(410_000n); // = 10% of the ₹41,000 income actually standing (va reversed)
    // a third payout gets no credit any more (and no notice)
    Object.assign(s.e('vc'), { status: 'PAID' });
    s.db.t('creditPayoutEntry').push(s.vis('vd', 'b4', 1_000_000n, 'PENDING'));
    const d3 = await s.visDownload();
    expect(d3.tdsCreditApplied).toEqual([]);
    expect(s.e('vd').tdsDeductedPaise).toBe(100_000n);
  });

  it('concurrency: a credit used by a racing download between plan and write → download rolled back; retry withholds in full', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 5_000_000n, 'PENDING'));
    let fired = false;
    s.db.onDownloadCreate = () => {
      if (fired) return;
      fired = true;
      s.credit()[0].appliedPaise = 400_000n; // another download used the whole credit
    };
    await expect(s.visDownload()).rejects.toThrow(/TDS credit .* changed while the payout file was being built/);
    expect(s.e('vb')).toMatchObject({ status: 'PENDING', tdsDeductedPaise: 0n });
    expect(s.apps()).toHaveLength(0);
    // The racing download committed (its writes survive our rollback): it paid vx ₹50,000 using the whole ₹4,000
    // credit (+ ₹1,000 withheld). The retry sees no credit left and withholds vb's TDS in full.
    s.db.t('creditPayoutEntry').push(s.vis('vx', 'b4', 5_000_000n, 'PROCESSING', { tdsDeductedPaise: 100_000n }));
    s.led('vx', 100_000n);
    s.db.t('tdsCreditApplication').push({
      id: 'app-vx', tdsCreditId: s.credit()[0].id, clientId: TENANT, payoutEntryId: 'vx', downloadId: 'dl-x',
      amountPaise: 400_000n, releasedAt: null, releaseReason: null, createdAt: new Date(),
    });
    s.credit()[0].appliedPaise = 400_000n;
    const dl = await s.visDownload();
    expect(dl.tdsCreditApplied).toEqual([]);
    expect(s.e('vb').tdsDeductedPaise).toBe(500_000n);
    // never double-used: Σ deposited (₹4,000 + ₹1,000 + ₹5,000) = 10% of the ₹1,00,000 income standing (vx + vb)
    expect(s.ledgerSum()).toBe(1_000_000n);
    expect(s.apps()).toHaveLength(1);
  });

  it('undo: the payout that used the credit is cancelled by a reversal → the credit comes back (under its lock), and a later payout uses it', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 5_000_000n, 'PENDING'));
    await s.visDownload();
    // the bank rejects vb (the UTR FAILED path clears the stamp + offsets the ₹1,000 in the ledger — simulated here)
    Object.assign(s.e('vb'), { status: 'FAILED', tdsDeductedPaise: 0n });
    s.led('vb', -100_000n);
    s.db.execCalls = [];
    const { done } = await s.reverse('b3', ['vb'], 5_000_000);
    expect(s.r194Locked()).toBe(true); // the credit's lock, although vb carries no withholding any more
    expect(s.e('vb').status).toBe('REVERSED');
    expect(s.apps()).toMatchObject([{ payoutEntryId: 'vb', releaseReason: 'ENTRY_CANCELLED_BY_REVERSAL' }]);
    expect(s.apps()[0].releasedAt).toBeInstanceOf(Date);
    expect(s.credit()[0].appliedPaise).toBe(0n);
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Entry cancelled · ₹50,000.00 · will not be paid (the bank payment had failed) · ₹4,000.00 TDS credit it had used returned to the credit balance',
    );
    // a later payout re-applies it
    s.db.t('creditPayoutEntry').push(s.vis('vc', 'b4', 5_000_000n, 'PENDING'));
    const dl = await s.visDownload();
    expect(dl.tdsCreditApplied[0]).toMatchObject({ entryId: 'vc', creditPaise: 400_000, withheldPaise: 100_000 });
    expect(s.ledgerSum()).toBe(500_000n);
  });

  it('reversing a PAID payout that itself used a credit: the credit = its own withholding + the earlier credit it used', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 5_000_000n, 'PENDING'));
    await s.visDownload();
    Object.assign(s.e('vb'), { status: 'PAID' });
    const { r, done } = await s.reverse('b3', ['vb'], 5_000_000);
    expect(s.reversal(r.id).shortfallPaise).toBe(4_900_000n); // net received
    const c = s.credit().find((x) => x.sourcePayoutEntryId === 'vb')!;
    expect(c.amountPaise).toBe(500_000n); // ₹1,000 withheld + ₹4,000 earlier credit — all deposited, all attributable to vb
    expect(done.payoutOutcome.receivable[0].tdsNote).toMatch(
      /₹1,000\.00 withheld from this payout \+ ₹4,000\.00 earlier TDS credit that had been used for this payout/,
    );
    // no income left on the PAN → Σ open credit (₹5,000) = Σ deposited (₹5,000)
    const open = s.credit().reduce((n: bigint, x) => n + (x.amountPaise as bigint) - (x.appliedPaise as bigint), 0n);
    expect(open).toBe(s.ledgerSum());
  });

  it('D4 — 194R (the client deducts): another client’s credit, ledger and base never count here', async () => {
    const s = visSetup();
    await s.reverse('b2', ['va'], 4_000_000);
    expect(s.credit()).toMatchObject([{ section: 'SEC_194R', amountPaise: 400_000n }]);
    s.credit()[0].clientId = 'deoleo'; // now it is another client's credit (+ its deposit is another client's)
    for (const l of s.db.t('tdsDeductionEntry')) l.clientId = 'deoleo';
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 5_000_000n, 'PENDING'));
    const dl = await s.visDownload();
    expect(dl.tdsCreditApplied).toEqual([]);
    expect(s.credit()[0].appliedPaise).toBe(0n);
    // ₹50,000 > ₹20,000 FY threshold → 10% of this client's own base (₹50,000), no other client's deposit counted
    expect(s.e('vb').tdsDeductedPaise).toBe(500_000n);
  });
});

describe('Owner D1 (2026-11-19, every tenant): a 194C payout can not be reversed once PAID', () => {
  const as194CPaid = (s: ReturnType<typeof setup>) => Object.assign(s.e('pe-a'), { tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' });

  it.each(['LEGACY', 'SHADOW'] as const)('%s: a request that needs the PAID 194C entry is refused with the owner wording', async (mode) => {
    const s = setup(mode);
    as194CPaid(s);
    await expect(s.service.createReversal(admin, 'b1', req(30_000))).rejects.toThrow(
      /^194C payouts can't be reversed once paid — this payout \(₹300\.00\) already reached the retailer/,
    );
    // an unpaid entry of the same outlet + field still reverses as before
    const r = await s.service.createReversal(admin, 'b1', req(50_000));
    await approve(s, r.id);
    expect(s.e('pe-b').status).toBe('REVERSED');
    expect(s.e('pe-a').status).toBe('PAID');
  });

  it('LEGACY: an entry paid AFTER the request was raised is refused at approval (the admin rejects it instead)', async () => {
    const s = setup('LEGACY');
    Object.assign(s.e('pe-b'), { tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' });
    const r = await s.service.createReversal(admin, 'b1', req(50_000));
    Object.assign(s.e('pe-b'), { status: 'PAID' }); // the UTR came in meanwhile
    await expect(approve(s, r.id)).rejects.toThrow(/194C payouts can't be reversed once paid/);
    expect(s.reversal(r.id).status).toBe('PENDING_GIFSY');
  });

  it('LEGACY: a legacy visibility row with no frozen section is 194C by default — refused too', async () => {
    const s = setup('LEGACY');
    s.db.t('creditField').push({ id: 'f1', clientId: TENANT, payoutStream: 'VISIBILITY', isActive: true });
    await expect(s.service.createReversal(admin, 'b1', req(30_000))).rejects.toThrow(/194C payouts can't be reversed once paid/);
  });

  it('V2: the picker shows the PAID 194C entry blocked with the reason; selecting it is refused; approve refuses one paid since', async () => {
    const s = setup('V2');
    as194CPaid(s);
    const res = await s.service.listPayoutReversalEntries(admin, 'b1', { outletId: 'O1', fieldId: 'f1' });
    expect(res.entries.find((c) => c.id === 'pe-a')).toMatchObject({ selectable: false, blockedBy: 'PAID_194C' });
    await expect(s.service.createReversal(admin, 'b1', req(30_000, ['pe-a']))).rejects.toThrow(
      /cannot be reversed: it is a paid 194C payout — 194C payouts can't be reversed once paid/,
    );
    Object.assign(s.e('pe-b'), { tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' });
    const r = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    Object.assign(s.e('pe-b'), { status: 'PAID' });
    await expect(approve(s, r.id)).rejects.toThrow(/194C payouts can't be reversed once paid/);
    expect(s.allocs(r.id)).toMatchObject([{ state: 'RESERVED' }]);
    expect(s.db.t('tdsCredit')).toHaveLength(0);
    expect(s.e('pe-b').tdsBaseReversedAt).toBeNull();
  });
});

/**
 * 194R on the SHIPPED whole-year definition (merge decision A, 2026-11-19): the client's CURRENT method is DEDUCT
 * (only then is 194R visibility withheld), and the PAID payouts went through a bank file made in FY 2026-27 (the
 * shared definition dates a payout by its bank file).
 */
// ─── Fix round B (owner 2026-11-16): H1 credit cap, D1 base always leaves, D3 hand-back visible, D5 remarks ───
// (visSetup is 194R / DEDUCT / bank file in FY 2026-27 since the 2026-11-19 fix round.)
function h1Setup(section: 'SEC_194R' | 'SEC_194C' = 'SEC_194R') {
  const s = visSetup();
  s.db.tables.creditPayoutEntry = s.db.t('creditPayoutEntry').filter((e) => e.id !== 'va');
  s.db.tables.tdsDeductionEntry = [];
  const led = (entryId: string, paise: bigint, clientId = TENANT) =>
    s.db.t('tdsDeductionEntry').push({
      id: `led-${entryId}`, clientId, panNumber: PAN, section, fyLabel: FY, creditPayoutEntryId: entryId,
      tdsDeductedThisPaise: paise, createdAt: new Date('2026-11-01'),
    });
  return { ...s, led, sec: { tdsSection: section } };
}

describe('Fix round B — H1 / D1 / D3 / D4 / D5', () => {
  it('H1 auditor example (194R 10%, ₹20,000 FY threshold): A ₹15k · B ₹10k (₹2,500 withheld) · C ₹10k (₹1,000) — reversing B credits ₹1,000, not ₹2,500', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(
      s.vis('A', 'b3', 1_500_000n, 'PAID', s.sec),
      s.vis('B', 'b2', 1_000_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 250_000n }),
      s.vis('C', 'b4', 1_000_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 100_000n }),
    );
    s.led('B', 250_000n);
    s.led('C', 100_000n);
    const { r, done } = await s.reverse('b2', ['B'], 1_000_000);
    expect(s.credit()).toMatchObject([{ sourcePayoutEntryId: 'B', amountPaise: 100_000n }]);
    expect(s.reversal(r.id).shortfallPaise).toBe(750_000n); // net received
    expect(done.payoutOutcome.receivable[0]).toMatchObject({ tdsCreditPaise: 100_000, coversOtherPayoutsPaise: 150_000, handBackPaise: 0 });
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Recorded as owed · ₹7,500.00 (net of ₹2,500.00 TDS withheld from ₹10,000.00) · ₹1,000.00 TDS credit carried forward on PAN XXXXX1234F · ' +
        "₹1,500.00 of this TDS covers the retailer's other payouts — no credit",
    );
    // the cumulative identity holds: Σ deposited − Σ open credit = TDS due on the income still standing (A + C = ₹25,000)
    const open = s.credit().reduce((n: bigint, x) => n + (x.amountPaise as bigint) - (x.appliedPaise as bigint), 0n);
    expect(s.ledgerSum() - open).toBe(250_000n);
    // next payout D ₹10,000: due ₹3,500 on ₹35,000 − ₹3,500 deposited → the ₹1,000 credit covers D's own ₹1,000
    s.db.t('creditPayoutEntry').push(s.vis('D', 'b4', 1_000_000n, 'PENDING', s.sec));
    const dl = await s.visDownload();
    expect(dl.tdsCreditApplied).toEqual([expect.objectContaining({ entryId: 'D', duePaise: 100_000, creditPaise: 100_000, withheldPaise: 0 })]);
    expect(s.e('D').tdsDeductedPaise).toBe(0n);
    expect(s.ledgerSum()).toBe(350_000n);
  });

  it('owner D1: a PAID 194C payout can not be reversed on V2 either — no 194C credit, no 194C base change, ever', async () => {
    const s = h1Setup('SEC_194C');
    s.db.t('creditPayoutEntry').push(s.vis('B', 'b2', 1_000_000n, 'PAID', { tdsSection: 'SEC_194C', tdsDeductedPaise: 105_000n }));
    s.led('B', 105_000n);
    await expect(
      s.service.createReversal(admin, 'b2', { ...req(1_000_000, ['B']), originalPaise: 1_000_000, fieldId: 'fv', fieldName: 'Visibility' }),
    ).rejects.toThrow(/194C payouts can't be reversed once paid/);
    expect(s.db.t('tdsCredit')).toHaveLength(0);
    expect(s.e('B').tdsBaseReversedAt).toBeNull();
  });

  it('D1 + D3: reversing a PAID payout with NO TDS still leaves the base; the PAN falls below the limit; the over-deduction is handed back on the next payout — visibly', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(
      s.vis('A', 'b2', 1_500_000n, 'PAID', s.sec), // ₹15,000, no TDS (below ₹20,000)
      s.vis('B', 'b3', 1_000_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 250_000n }), // crossed: ₹2,500 (all catch-up)
    );
    s.led('B', 250_000n);
    const { r, done } = await s.reverse('b2', ['A'], 1_500_000);
    expect(s.e('A').tdsBaseReversedAt).toBeInstanceOf(Date); // D1 — off the base although no TDS was withheld
    expect(s.credit()).toHaveLength(0);
    expect(s.reversal(r.id).shortfallPaise).toBe(1_500_000n);
    expect(done.payoutOutcome.receivable[0]).toMatchObject({ handBackPaise: 250_000, belowThresholdAfterReversal: true, tdsCreditPaise: 0 });
    expect(done.payoutOutcome.lines[0].text).toBe(
      'Recorded as owed · ₹15,000.00 · no TDS withheld — no TDS credit · PAN XXXXX1234F now below the TDS threshold · ' +
        '₹2,500.00 over-deducted TDS handed back on the next payout on PAN XXXXX1234F',
    );
    // next payout D ₹15,000 → B + D = ₹25,000 > ₹20,000 → ₹2,500 due, already deposited → ₹0 withheld, and it SAYS why
    s.db.t('creditPayoutEntry').push(s.vis('D', 'b4', 1_500_000n, 'PENDING', s.sec));
    const dl = await s.visDownload();
    expect(s.e('D').tdsDeductedPaise).toBe(0n);
    expect(dl.tdsAdjustments).toEqual([
      expect.objectContaining({
        entryId: 'D', handBackPaise: 250_000, panMasked: 'XXXXX1234F',
        note: 'TDS due ₹2,500.00 · ₹2,500.00 less TDS: adjusted after a reversal brought PAN below the limit · ₹0.00 withheld from this payout',
      }),
    ]);
    expect(s.db.t('auditLog').find((a) => a.entityType === 'TDS_REVERSAL_ADJUSTMENT')).toMatchObject({ entityId: dl.downloadId });
    const sum = await s.service.payoutDownloadSummary(gifsy, { id: dl.downloadId });
    expect(sum!.tdsAdjustments).toMatchObject({ count: 1, paise: 250_000 });
    expect(s.ledgerSum()).toBe(250_000n); // the money is the ledger's — unchanged rule, now explained
  });

  // ── Merge with 7ba69566 (2026-11-19) ──────────────────────────────────────────────────────────────────────────
  // ── Owner D2 (2026-11-19): a FULLY withheld PAID 194R payout reversed on V2 → REVERSED, nothing owed, TDS credit ──
  it('owner D2: V2 reversal of a PAID 194R entry FULLY withheld as TDS → REVERSED, nothing owed, the deposited TDS becomes a credit (no negative ledger row)', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(
      s.vis('A', 'b3', 1_900_000n, 'PAID', s.sec), // ₹19,000 — under the limit, no TDS
      s.vis('W', 'b2', 150_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 150_000n, utr: 'TDS-WITHHELD-DL1' }), // ₹1,500, all withheld
    );
    s.led('W', 150_000n);
    const { r, done } = await s.reverse('b2', ['W'], 150_000);
    // REVERSED, the TDS stamp + ledger kept (it is deposited), nothing owed
    expect(s.e('W')).toMatchObject({ status: 'REVERSED', tdsDeductedPaise: 150_000n });
    expect(s.ledgerSum()).toBe(150_000n);
    expect(s.db.t('tdsDeductionEntry').some((x) => (x.tdsDeductedThisPaise as bigint) < 0n)).toBe(false);
    expect(s.reversal(r.id).shortfallPaise).toBe(0n);
    expect(s.allocs(r.id)).toMatchObject([{ state: 'APPLIED_CANCELLED', receivablePaise: 0n, tdsCreditPaise: 150_000n, tdsOffsetPaise: 0n }]);
    expect(s.credit()).toMatchObject([{ sourcePayoutEntryId: 'W', amountPaise: 150_000n, section: 'SEC_194R', fyLabel: FY, panNumber: PAN }]);
    expect(s.r194Locked()).toBe(true);
    expect(done.payoutOutcome.headline).toBe(
      'Approved · 1 fully-withheld payout reversed (₹1,500.00) — nothing reached the retailer, nothing owed · ₹1,500.00 TDS credit carried forward',
    );
    expect(done.payoutOutcome.lines).toEqual([
      {
        kind: 'REVERSED_WITHHELD',
        entryId: 'W',
        text:
          'Entry reversed · ₹1,500.00 · the whole payout had been withheld as TDS (₹1,500.00), nothing reached the retailer — nothing owed · ' +
          '₹1,500.00 TDS credit carried forward on PAN XXXXX1234F — used against the next TDS so it is never deducted twice',
      },
    ]);
    expect(done.payoutOutcome.cancelled).toEqual([]); // B4: not "cancelled"
    expect(done.payoutOutcome.reversedWithheld).toMatchObject([{ entryId: 'W', tdsCreditPaise: 150_000 }]);
    // the processed-reversals list marks it (B4) — "fully withheld", not "cancelled"
    const list = await s.service.listReversals(gifsy, {});
    expect((list.reversals as Row[]).find((x) => x.id === r.id)!.payoutEntries).toMatchObject([
      { payoutEntryId: 'W', allocationState: 'APPLIED_CANCELLED', tdsCreditPaise: 150_000, fullyWithheld: true },
    ]);
  });

  it('owner D2 worked example (Ramesh): ₹19,000 · ₹1,500 fully withheld, reversed · next ₹10,000 → ₹1,400 withheld → Ramesh gets ₹8,600 (not ₹7,100)', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(
      s.vis('A', 'b3', 1_900_000n, 'PAID', s.sec),
      s.vis('W', 'b2', 150_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 150_000n, utr: 'TDS-WITHHELD-DL1' }),
    );
    s.led('W', 150_000n);
    await s.reverse('b2', ['W'], 150_000);
    s.db.t('creditPayoutEntry').push(s.vis('N', 'b4', 1_000_000n, 'PENDING', s.sec));
    const dl = await s.visDownload();
    // year without W: ₹19,000 + ₹10,000 = ₹29,000 → ₹2,900 due; ₹1,500 already deposited (the credit) → ₹1,400 withheld
    expect(s.e('N').tdsDeductedPaise).toBe(140_000n);
    expect(dl.tdsCreditApplied).toEqual([expect.objectContaining({ entryId: 'N', duePaise: 290_000, creditPaise: 150_000, withheldPaise: 140_000 })]);
    expect(1_000_000n - (s.e('N').tdsDeductedPaise as bigint)).toBe(860_000n); // Ramesh receives ₹8,600
    // never deducted twice: Σ deposited ₹1,500 + ₹1,400 = ₹2,900 = 10% of the ₹29,000 standing
    expect(s.ledgerSum()).toBe(290_000n);
  });

  it('owner D2 on GROSS_UP now (A5): REVERSED, nothing owed, NO credit — the withheld TDS stays the flagged excess, said so', async () => {
    const s = h1Setup();
    s.settings.resolveTdsPolicy.mockImplementation(async () => ({ section: 'SEC_194R', methodology: 'GROSS_UP' }));
    s.db.t('creditPayoutEntry').push(s.vis('W', 'b2', 150_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 150_000n }));
    s.led('W', 150_000n);
    const { done } = await s.reverse('b2', ['W'], 150_000);
    expect(s.e('W').status).toBe('REVERSED');
    expect(s.credit()).toHaveLength(0);
    expect(done.payoutOutcome.lines[0].text).toMatch(/nothing owed · no TDS credit — .*stays on the 194R report as TDS taken in excess/);
  });

  it('194R credit lives in the ledger row FY under the R194 client+FY lock and is keyed on the ledger row key', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(
      s.vis('A', 'b3', 1_500_000n, 'PAID', s.sec),
      s.vis('B', 'b2', 1_000_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 250_000n }),
      s.vis('C', 'b4', 1_000_000n, 'PAID', { ...s.sec, tdsDeductedPaise: 100_000n }),
    );
    s.led('B', 250_000n);
    s.led('C', 100_000n);
    s.db.t('tdsDeductionEntry').find((x) => x.creditPayoutEntryId === 'B')!.panNumber = ' abcde1234f '; // stored un-normalised
    await s.reverse('b2', ['B'], 1_000_000);
    expect(s.credit()).toMatchObject([{ section: 'SEC_194R', fyLabel: FY, panNumber: PAN, clientId: TENANT }]);
    expect(
      s.db.execCalls.some(
        (c) => c.sql.includes('pg_advisory_xact_lock') && Array.isArray(c.values[0]) && (c.values[0] as string[]).includes(`R194|${TENANT}|${FY}`),
      ),
    ).toBe(true);
  });

  it('194C Deoleo byte-identical: ANOTHER tenant’s engine-reversed payout still counts in this tenant’s base (only the reversing tenant’s view changes)', async () => {
    const s = h1Setup('SEC_194C');
    s.db.t('outlet').push({ clientId: 'deoleo', outletCode: 'D1', name: 'Deo One', isActive: true, partnerId: 'p1', partner: { panNumber: PAN } });
    // the other programme's ₹95,000 payout on the PAN — reversed by ITS engine (marker set)
    s.db.t('creditPayoutEntry').push(
      entry('X', 9_500_000n, 'PAID', {
        clientId: 'deoleo', outletId: 'D1', batchId: 'bd', fieldId: 'fd', tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT',
        tdsBaseReversedAt: new Date('2026-11-10'), tdsBaseReversalId: 'deo-rev',
      }),
    );
    s.db.t('creditPayoutEntry').push(s.vis('vb', 'b3', 1_000_000n, 'PENDING', { tdsSection: 'SEC_194C' }));
    const dl = await s.visDownload();
    // ₹95,000 + ₹10,000 = ₹1,05,000 > ₹1,00,000 → 1% of the DEDUCT base ₹1,05,000 = ₹1,050 — exactly as without the marker
    expect(s.e('vb').tdsDeductedPaise).toBe(105_000n);
    expect(dl.tdsAdjustments).toEqual([]);
    expect(dl.tdsCreditApplied).toEqual([]);
  });

  it('no reversal on the PAN → no adjustment line, the plan is the unchanged computation', async () => {
    const s = h1Setup();
    s.db.t('creditPayoutEntry').push(s.vis('B', 'b3', 2_500_000n, 'PENDING', s.sec));
    const dl = await s.visDownload();
    expect(dl.tdsAdjustments).toEqual([]);
    expect(dl.tdsCreditApplied).toEqual([]);
    expect(s.e('B').tdsDeductedPaise).toBe(250_000n);
    expect(s.db.t('auditLog').some((a) => a.entityType === 'TDS_REVERSAL_ADJUSTMENT')).toBe(false);
  });

  it('D5: typed remarks are saved on create (requestRemarks) and approve / reject (remarks), and audited', async () => {
    const s = setup('V2');
    const r1 = await s.service.createReversal(admin, 'b1', { ...req(50_000, ['pe-b']), remarks: '  wrong outlet  ' });
    expect(s.reversal(r1.id).requestRemarks).toBe('wrong outlet');
    expect(s.db.t('auditLog').find((a) => a.action === 'CREATE')!.metadata).toMatchObject({ remarks: 'wrong outlet' });
    await s.service.patchReversal(gifsy, r1.id, { action: ReversalAction.reject, remarks: ' duplicate request ' });
    expect(s.reversal(r1.id)).toMatchObject({ status: 'REJECTED', remarks: 'duplicate request', requestRemarks: 'wrong outlet' });
    expect(s.db.t('auditLog').find((a) => a.action === 'REJECT')!.metadata).toMatchObject({ remarks: 'duplicate request' });
    const r2 = await s.service.createReversal(admin, 'b1', req(50_000, ['pe-b']));
    expect(s.reversal(r2.id).requestRemarks ?? null).toBeNull(); // nothing typed → nothing written
    await s.service.patchReversal(gifsy, r2.id, { action: ReversalAction.approve, remarks: 'ok' });
    expect(s.reversal(r2.id).remarks).toBe('ok');
    expect(s.db.t('auditLog').find((a) => a.action === 'APPROVE')!.metadata).toMatchObject({ remarks: 'ok' });
  });

  it('D5 LEGACY tenant: the requester\'s remarks are saved too (every tenant)', async () => {
    const s = setup('LEGACY');
    const r = await s.service.createReversal(admin, 'b1', { ...req(50_000), remarks: 'customer returned stock' });
    expect(s.reversal(r.id).requestRemarks).toBe('customer returned stock');
    await s.service.patchReversal(gifsy, r.id, { action: ReversalAction.approve, remarks: 'approved after call' });
    expect(s.reversal(r.id).remarks).toBe('approved after call');
  });

  it('D5 validation: remarks over 1,000 characters are refused', async () => {
    const dto = plainToInstance(CreateReversalDto, { ...req(50_000), remarks: 'x'.repeat(1001) });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('remarks');
  });
});
