/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory emulation of exactly the Prisma surface the HELD OPENING BALANCES code touches (held-balance-apply,
 * backfill sequenceWalletInTx, held-opening-balances.service, the digest figures). Test-only (the `.test-spec.ts`
 * suffix keeps it out of both the build and the jest test glob — same convention as dispersal-test-kit).
 * SAVEPOINT / ROLLBACK TO SAVEPOINT and $transaction rollback are emulated with full table snapshots, so a test can
 * prove "never partially posted".
 */
type Row = Record<string, any>;

const num = (x: any) => (x instanceof Date ? x.getTime() : x);
let idSeq = 0;
const nid = (p: string) => `${p}${++idSeq}`;

export interface HeldDb {
  wallets: Row[];
  walletTxns: Row[];
  ledger: Row[];
  held: Row[];
  outlets: Row[];
  partners: Row[];
  users: Row[];
  bells: Row[];
  audits: Row[];
  positions: Row[];
}

export function emptyDb(): HeldDb {
  return { wallets: [], walletTxns: [], ledger: [], held: [], outlets: [], partners: [], users: [], bells: [], audits: [], positions: [] };
}

export const blankWallet = (id: string, partnerId: string, extra: Row = {}): Row => ({
  id,
  partnerId,
  accountId: null,
  earnedPoints: 0,
  lockedPoints: 0,
  redeemablePoints: 0,
  redeemedPoints: 0,
  expiredPoints: 0,
  lifetimeEarned: 0,
  lifetimeRedeemed: 0,
  lifetimeExpired: 0,
  lastTransactionAt: null,
  debtPoints: 0,
  movementSeq: 0,
  backfillStatus: null,
  backfillBlockedReason: null,
  backfillCheckedAt: null,
  ...extra,
});

export function heldRow(extra: Row): Row {
  return {
    id: nid('hob_'),
    clientId: 'bajaj',
    source: 'vendor-earnburn-2026-11-11',
    eventTotals: null,
    status: 'PENDING',
    appliedAt: null,
    appliedWalletId: null,
    applyMode: null,
    appliedBy: null,
    sequencing: null,
    failureReason: null,
    failedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    createdAt: new Date(Date.now() - 60_000),
    createdBy: null,
    updatedAt: new Date(),
    ...extra,
  };
}

function matchWhere(db: HeldDb, table: keyof HeldDb, row: Row, where: Row | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'partner' && table === 'wallets') {
      const p = db.partners.find((x) => x.id === row.partnerId);
      if (!p || (v.clientId !== undefined && p.clientId !== v.clientId)) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => matchWhere(db, table, row, w))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (matchWhere(db, table, row, v)) return false;
      continue;
    }
    if (k === 'transactions' && table === 'wallets') {
      const has = db.walletTxns.some((t) => t.walletId === row.id);
      if ('some' in v && !has) return false;
      continue;
    }
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      const r = row[k];
      if ('in' in v && !(v.in as any[]).includes(r)) return false;
      if ('gt' in v && !(r !== null && r !== undefined && num(r) > num(v.gt))) return false;
      if ('gte' in v && !(r !== null && r !== undefined && num(r) >= num(v.gte))) return false;
      if ('lt' in v && !(r !== null && r !== undefined && num(r) < num(v.lt))) return false;
      if ('lte' in v && !(r !== null && r !== undefined && num(r) <= num(v.lte))) return false;
      if ('not' in v && (v.not === null ? r === null || r === undefined : r === v.not)) return false;
      if ('contains' in v && !(typeof r === 'string' && r.toLowerCase().includes(String(v.contains).toLowerCase()))) return false;
      continue;
    }
    if (v instanceof Date) {
      if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && ('increment' in v || 'decrement' in v)) {
      row[k] = (row[k] ?? 0) + ('increment' in v ? v.increment : -v.decrement);
    } else row[k] = v;
  }
  row.updatedAt = new Date();
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

function clone(db: HeldDb): HeldDb {
  const c = (rows: Row[]) => rows.map((r) => ({ ...r }));
  return {
    wallets: c(db.wallets), walletTxns: c(db.walletTxns), ledger: c(db.ledger), held: c(db.held), outlets: c(db.outlets),
    partners: c(db.partners), users: c(db.users), bells: c(db.bells), audits: c(db.audits), positions: c(db.positions),
  };
}

function restore(db: HeldDb, snap: HeldDb): void {
  for (const k of Object.keys(snap) as (keyof HeldDb)[]) {
    db[k].length = 0;
    db[k].push(...snap[k].map((r) => ({ ...r })));
  }
}

const digest = (rows: Row[], cols: string[]) =>
  rows
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => cols.map((c) => String(r[c] instanceof Date ? r[c].toISOString() : r[c])).join('|'))
    .join(',');

/** Build a fake Prisma client (+ tx) over `db`. `failOn` injects a throw on the n-th call of an op. */
export function fakePrisma(db: HeldDb, opts: { failOn?: { op: string; error?: string } } = {}) {
  const savepoints = new Map<string, HeldDb>();
  const ops: string[] = [];
  const maybeFail = (op: string) => {
    ops.push(op);
    if (opts.failOn && opts.failOn.op === op) throw new Error(opts.failOn.error ?? `injected failure in ${op}`);
  };
  const DEFAULTS: Partial<Record<keyof HeldDb, Row>> = {
    walletTxns: { seq: null, pointsDelta: null, reversedCreditTxId: null, creditReversalId: null, pointsLedgerId: null, referenceType: null, referenceId: null, metadata: null },
    ledger: { isExpired: false, isClaimed: false, lockedUntil: null, expiresAt: null, schemeId: null, remainingPoints: 0 },
  };
  const tableApi = (table: keyof HeldDb, prefix: string) => ({
    findMany: async (a: Row = {}) => {
      maybeFail(`${table}.findMany`);
      let rows = db[table].filter((r) => matchWhere(db, table, r, a.where));
      rows = orderRows(rows, a.orderBy);
      if (a.skip) rows = rows.slice(a.skip);
      if (a.take) rows = rows.slice(0, a.take);
      return rows.map((r) => withCount(table, r, a.select));
    },
    findFirst: async (a: Row = {}) => {
      maybeFail(`${table}.findFirst`);
      const rows = orderRows(db[table].filter((r) => matchWhere(db, table, r, a.where)), a.orderBy);
      return rows[0] ? withCount(table, rows[0], a.select) : null;
    },
    findUnique: async (a: Row) => {
      maybeFail(`${table}.findUnique`);
      const r = db[table].find((x) => matchWhere(db, table, x, a.where));
      return r ? { ...r } : null;
    },
    findUniqueOrThrow: async (a: Row) => {
      const r = db[table].find((x) => matchWhere(db, table, x, a.where));
      if (!r) throw new Error(`${table} not found`);
      return { ...r };
    },
    findFirstOrThrow: async (a: Row) => {
      const r = db[table].find((x) => matchWhere(db, table, x, a.where));
      if (!r) throw new Error(`${table} not found`);
      return { ...r };
    },
    count: async (a: Row = {}) => db[table].filter((r) => matchWhere(db, table, r, a.where)).length,
    create: async (a: Row) => {
      maybeFail(`${table}.create`);
      const row = { id: nid(prefix), createdAt: new Date(), ...DEFAULTS[table], ...a.data };
      db[table].push(row);
      return { ...row };
    },
    createMany: async (a: Row) => {
      maybeFail(`${table}.createMany`);
      for (const d of a.data) db[table].push({ id: nid(prefix), createdAt: new Date(), ...DEFAULTS[table], ...d });
      return { count: a.data.length };
    },
    updateMany: async (a: Row) => {
      maybeFail(`${table}.updateMany`);
      const rows = db[table].filter((r) => matchWhere(db, table, r, a.where));
      rows.forEach((r) => applyData(r, a.data));
      return { count: rows.length };
    },
    update: async (a: Row) => {
      const r = db[table].find((x) => matchWhere(db, table, x, a.where));
      if (!r) throw new Error(`${table} not found`);
      applyData(r, a.data);
      return { ...r };
    },
    groupBy: async (a: Row) => {
      const rows = db[table].filter((r) => matchWhere(db, table, r, a.where));
      const keyCol = a.by[0];
      const groups = new Map<any, Row[]>();
      for (const r of rows) groups.set(r[keyCol], [...(groups.get(r[keyCol]) ?? []), r]);
      return [...groups.entries()].map(([k, rs]) => ({
        [keyCol]: k,
        _count: { _all: rs.length, ...(a._count?.seq ? { seq: rs.filter((r) => r.seq !== null && r.seq !== undefined).length } : {}) },
        _sum: a._sum ? Object.fromEntries(Object.keys(a._sum).map((c) => [c, rs.reduce((s, r) => s + (r[c] ?? 0), 0)])) : undefined,
        _max: a._max ? Object.fromEntries(Object.keys(a._max).map((c) => [c, rs.reduce((m: number | null, r) => (r[c] == null ? m : m === null ? r[c] : Math.max(m, r[c])), null)])) : undefined,
      }));
    },
    aggregate: async (a: Row) => {
      const rows = db[table].filter((r) => matchWhere(db, table, r, a.where));
      return {
        _count: { _all: rows.length },
        _sum: Object.fromEntries(Object.keys(a._sum ?? {}).map((c) => [c, rows.length ? rows.reduce((s, r) => s + (r[c] ?? 0), 0) : null])),
      };
    },
  });
  const withCount = (table: keyof HeldDb, r: Row, select: Row | undefined) => {
    const out = { ...r };
    if (table === 'wallets' && select?._count) out._count = { transactions: db.walletTxns.filter((t) => t.walletId === r.id).length };
    return out;
  };

  const client: Row = {
    _ops: ops,
    wallet: tableApi('wallets', 'w_'),
    walletTransaction: tableApi('walletTxns', 'wtx_'),
    pointsLedger: tableApi('ledger', 'pl_'),
    heldOpeningBalance: tableApi('held', 'hob_'),
    outlet: tableApi('outlets', 'o_'),
    channelPartner: tableApi('partners', 'cp_'),
    user: tableApi('users', 'u_'),
    notificationQueue: tableApi('bells', 'nq_'),
    auditLog: tableApi('audits', 'al_'),
    walletCreditPosition: tableApi('positions', 'wcp_'),
    creditReversalAllocation: { create: async () => ({}) },
    $queryRaw: async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join('?');
      if (/FOR UPDATE/i.test(sql)) return [];
      if (/FROM wallet_transactions/i.test(sql)) {
        const rows = db.walletTxns.filter((t) => t.walletId === vals[0]);
        return [{ n: rows.length, d: digest(rows, ['id', 'transactionType', 'points', 'balanceBefore', 'balanceAfter', 'balanceType']) }];
      }
      if (/FROM points_ledger/i.test(sql)) {
        const rows = db.ledger.filter((t) => t.walletId === vals[0]);
        return [{ n: rows.length, d: digest(rows, ['id', 'transactionType', 'points', 'remainingPoints', 'isExpired', 'expiresAt', 'lockedUntil', 'isClaimed']) }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string) => {
      const m = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) (\w+)$/.exec(sql.trim());
      if (!m) throw new Error(`unexpected raw SQL ${sql}`);
      if (m[1] === 'SAVEPOINT') savepoints.set(m[2], clone(db));
      else if (m[1] === 'RELEASE SAVEPOINT') savepoints.delete(m[2]);
      else {
        const snap = savepoints.get(m[2]);
        if (!snap) throw new Error(`no savepoint ${m[2]}`);
        restore(db, snap);
      }
      return 0;
    },
  };
  client.$transaction = async (fn: (tx: any) => Promise<any>) => {
    const snap = clone(db);
    try {
      return await fn(client);
    } catch (e) {
      restore(db, snap);
      throw e;
    }
  };
  return client;
}

/** A Bajaj-style passbook: two earns, a redemption, a lapse → closing 600. */
export const SAMPLE_EVENTS = [
  { d: '2025-04-01', t: 'EARN', p: 500, l: 'Points earned' },
  { d: '2025-06-30', t: 'EARN', p: 400, l: 'Points earned — SPL4 Scratch Payout' },
  { d: '2025-06-30', t: 'REDEEM', p: -200, l: 'Points redeemed' },
  { d: '2026-06-30', t: 'EXPIRE', p: -100, l: 'Points expired' },
];
