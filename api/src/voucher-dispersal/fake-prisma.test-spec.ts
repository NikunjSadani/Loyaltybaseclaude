/**
 * TEST-ONLY in-memory Prisma fake for the Voucher Dispersal specs (excluded from the build by the
 * `**\/*spec.ts` pattern; not a test file itself — jest only runs `*.spec.ts`).
 * Supports exactly the query subset the module uses: equality (incl. null / Date / bigint), in, notIn,
 * not, lt, has, OR, AND, JSON path+equals; composite unique keys (rows: campaign+dedupePhone,
 * campaign+batch+rowNumber, hubbleReferenceId; batches: campaign+batchNumber); update data with increment / push; orderBy / skip / take; aggregate (_count,
 * _sum.amountPaise); groupBy (any `by` list, default [campaignId, status]); $transaction(fn) (sequential, no isolation needed).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

let idSeq = 0;
const nextId = (p: string) => `${p}${(++idSeq).toString().padStart(6, '0')}`;
let clock = 0;
const tick = () => new Date(Date.now() + ++clock);

function eq(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && BigInt(a) === BigInt(b);
  return (a ?? null) === (b ?? null);
}

export function matches(rec: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR') {
      if (!(cond as Rec[]).some((c) => matches(rec, c))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as Rec[]).every((c) => matches(rec, c))) return false;
      continue;
    }
    let v = rec[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && Array.isArray((cond as Rec).path)) {
      // JSON path filter (Prisma `{ path: ['a'], equals: x }`).
      for (const seg of (cond as Rec).path as string[]) v = v == null ? undefined : v[seg];
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as any[]).some((x) => eq(v, x))) return false;
      if ('notIn' in cond && (cond.notIn as any[]).some((x) => eq(v, x))) return false;
      if ('not' in cond && eq(v, cond.not)) return false;
      if ('lt' in cond && !(v != null && v < cond.lt)) return false;
      if ('gte' in cond && !(v != null && v >= cond.gte)) return false;
      if ('has' in cond && !(Array.isArray(v) && v.includes(cond.has))) return false;
      if ('equals' in cond && !eq(v, cond.equals)) return false;
      continue;
    }
    if (!eq(v, cond)) return false;
  }
  return true;
}

function applyData(rec: Rec, data: Rec) {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('increment' in v) rec[k] = (rec[k] ?? 0) + v.increment;
      else if ('push' in v) rec[k] = [...(rec[k] ?? []), v.push];
      else rec[k] = v;
    } else if (v !== undefined) rec[k] = v;
  }
  // Like Prisma's @updatedAt: set automatically unless the write gives updatedAt explicitly.
  if (!('updatedAt' in data)) rec.updatedAt = tick();
}

function sortBy(list: Rec[], orderBy: any): Rec[] {
  if (!orderBy) return list;
  const specs: [string, 'asc' | 'desc'][] = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o: Rec) => Object.entries(o)) as any;
  return [...list].sort((a, b) => {
    for (const [f, dir] of specs) {
      const x = a[f];
      const y = b[f];
      if (eq(x, y)) continue;
      const lt = x == null ? true : y == null ? false : x < y;
      return (lt ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/** Composite unique keys (NULL members never collide — Postgres semantics). Throws like Prisma P2002. */
function checkUnique(store: Rec[], uniques: string[][]) {
  for (const keys of uniques) {
    const seen = new Set<string>();
    for (const r of store) {
      if (keys.some((k) => r[k] == null)) continue;
      const sig = keys.map((k) => String(r[k])).join('|');
      if (seen.has(sig)) throw new Error(`Unique constraint failed on the fields: (${keys.join(',')})`);
      seen.add(sig);
    }
  }
}

function table(store: Rec[], prefix: string, defaults: () => Rec, include?: (r: Rec, inc: Rec) => Rec, uniques: string[][] = []) {
  /** Apply a mutation; on a unique violation roll the store back and throw. */
  const guarded = <T>(fn: () => T): T => {
    const snapshot = store.map((r) => ({ ...r }));
    const out = fn();
    try {
      checkUnique(store, uniques);
    } catch (e) {
      store.splice(0, store.length, ...snapshot);
      throw e;
    }
    return out;
  };
  const find = (args: Rec = {}) => {
    let l = sortBy(store.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.skip) l = l.slice(args.skip);
    if (args.take) l = l.slice(0, args.take);
    return l.map((r) => (args.include && include ? include({ ...r }, args.include) : { ...r }));
  };
  return {
    store,
    create: jest.fn(async ({ data }: Rec) =>
      guarded(() => {
        const r = { ...defaults(), id: nextId(prefix), createdAt: tick(), updatedAt: tick(), ...data };
        store.push(r);
        return { ...r };
      }),
    ),
    createMany: jest.fn(async ({ data }: Rec) =>
      guarded(() => {
        for (const d of data) store.push({ ...defaults(), id: nextId(prefix), createdAt: tick(), updatedAt: tick(), ...d });
        return { count: data.length };
      }),
    ),
    findMany: jest.fn(async (args: Rec = {}) => find(args)),
    findFirst: jest.fn(async (args: Rec = {}) => find(args)[0] ?? null),
    findFirstOrThrow: jest.fn(async (args: Rec = {}) => {
      const r = find(args)[0];
      if (!r) throw new Error('not found');
      return r;
    }),
    findUnique: jest.fn(async (args: Rec = {}) => find(args)[0] ?? null),
    findUniqueOrThrow: jest.fn(async (args: Rec = {}) => {
      const r = find(args)[0];
      if (!r) throw new Error('not found');
      return r;
    }),
    update: jest.fn(async ({ where, data }: Rec) =>
      guarded(() => {
        const r = store.find((x) => matches(x, where));
        if (!r) throw new Error('Record to update not found');
        applyData(r, data);
        return { ...r };
      }),
    ),
    updateMany: jest.fn(async ({ where, data }: Rec) =>
      guarded(() => {
        const l = store.filter((x) => matches(x, where));
        l.forEach((r) => applyData(r, data));
        return { count: l.length };
      }),
    ),
    deleteMany: jest.fn(async ({ where }: Rec) => {
      const keep = store.filter((x) => !matches(x, where));
      const n = store.length - keep.length;
      store.splice(0, store.length, ...keep);
      return { count: n };
    }),
    count: jest.fn(async (args: Rec = {}) => store.filter((r) => matches(r, args.where)).length),
    aggregate: jest.fn(async ({ where }: Rec) => {
      const l = store.filter((r) => matches(r, where));
      const sum = l.reduce((a, r) => (r.amountPaise == null ? a : (a ?? 0n) + BigInt(r.amountPaise)), null as bigint | null);
      return { _count: { _all: l.length }, _sum: { amountPaise: sum } };
    }),
    groupBy: jest.fn(async ({ where, by }: Rec) => {
      const keys: string[] = by ?? ['campaignId', 'status'];
      const m = new Map<string, Rec>();
      for (const r of store.filter((x) => matches(x, where))) {
        const k = keys.map((f) => String(r[f])).join('|');
        const g = m.get(k) ?? { ...Object.fromEntries(keys.map((f) => [f, r[f]])), _count: { _all: 0 }, _sum: { amountPaise: null } };
        g._count._all++;
        if (r.amountPaise != null) g._sum.amountPaise = (g._sum.amountPaise ?? 0n) + BigInt(r.amountPaise);
        m.set(k, g);
      }
      return [...m.values()];
    }),
  };
}

export function makeFakePrisma() {
  const campaigns: Rec[] = [];
  const rows: Rec[] = [];
  const receipts: Rec[] = [];
  const audits: Rec[] = [];
  const batches: Rec[] = [];
  const users: Rec[] = [{ id: 'admin-1', name: 'Admin One' }, { id: 'admin-2', name: 'Admin Two' }];
  const clients: Rec[] = [{ id: 'bajaj', internalName: 'Bajaj Consumer Care', branding: { displayName: 'Bajaj' } }];
  const prisma: Rec = {
    voucherDispersalCampaign: table(campaigns, 'camp', () => ({
      note: null, status: 'DRAFT', sourceFileName: null, uploadedAt: null, uploadedById: null, confirmedById: null,
      confirmedAt: null, cancelledById: null, cancelledAt: null, completedAt: null, billedToClientId: null, settleFailures: 0, settleError: null,
    })),
    voucherDispersalRow: table(
      rows,
      'row',
      () => ({
        phone: null, rawPhone: null, dedupePhone: null, amountPaise: null, brandKey: null, brandLabel: null, productId: null,
        note: null, invalidReason: null, hubbleReferenceId: null, previousReferenceIds: [], hubbleAccount: null, hubbleOrderId: null,
        placeAttemptAt: null, placeResponded: null, claimToken: null, buyingAt: null, pendingReason: null, pendingSince: null,
        lastReconcileAt: null, lastReconcileResult: null, voucherCode: null, voucherPin: null, voucherValidTill: null, boughtAt: null,
        buyFailureReason: null, buyFailureSource: null, whatsappReceiptId: null, messageClaimedAt: null, sentAt: null,
        messageError: null, messageStatus: null, messageDeliveredAt: null, messageReadAt: null, messageFailureReason: null,
        resendCount: 0, attempts: 0, batchNumber: 1, warning: null, lateCompletedAt: null,
      }),
      (r, inc) => (inc.campaign ? { ...r, campaign: { ...campaigns.find((c) => c.id === r.campaignId) } } : r),
      [['campaignId', 'dedupePhone'], ['campaignId', 'batchNumber', 'rowNumber'], ['hubbleReferenceId']],
    ),
    voucherDispersalBatch: table(
      batches,
      'batch',
      () => ({
        previewId: null, sourceFileName: null, confirmedById: null, confirmedAt: null, discardedById: null, discardedAt: null,
        discardReason: null,
      }),
      undefined,
      [['campaignId', 'batchNumber']],
    ),
    user: table(users, 'user', () => ({})),
    messageDeliveryReceipt: table(receipts, 'rcpt', () => ({ status: 'QUEUED', sentAt: null, deliveredAt: null, readAt: null, failureReason: null })),
    auditLog: table(audits, 'audit', () => ({})),
    client: table(clients, 'client', () => ({})),
    redemptionOrder: { findMany: jest.fn(async () => []) },
  };
  // Interactive transaction: runs fn(prisma); if it THROWS, every table is restored to its state before the
  // transaction (rollback). Not isolated from concurrent transactions (no locks) — enough for the specs.
  const allStores = [campaigns, rows, receipts, audits, clients, batches, users];
  prisma.$transaction = jest.fn(async (fn: (tx: Rec) => Promise<unknown>) => {
    const snap = allStores.map((st) => st.map((r) => ({ ...r })));
    try {
      return await fn(prisma);
    } catch (e) {
      allStores.forEach((st, i) => st.splice(0, st.length, ...snap[i]));
      throw e;
    }
  });
  return { prisma, campaigns, rows, receipts, audits, clients, batches, users };
}
