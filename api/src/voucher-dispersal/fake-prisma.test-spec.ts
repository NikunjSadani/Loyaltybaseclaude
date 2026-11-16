/**
 * TEST-ONLY in-memory Prisma fake for the Voucher Dispersal specs (excluded from the build by the
 * `**\/*spec.ts` pattern; not a test file itself — jest only runs `*.spec.ts`).
 * Supports exactly the query subset the module uses: equality (incl. null / Date / bigint), in, notIn,
 * not, lt, has, OR, AND; update data with increment / push; orderBy / skip / take; aggregate (_count,
 * _sum.amountPaise); groupBy [campaignId, status]; $transaction(fn) (sequential, no isolation needed).
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
    const v = rec[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as any[]).some((x) => eq(v, x))) return false;
      if ('notIn' in cond && (cond.notIn as any[]).some((x) => eq(v, x))) return false;
      if ('not' in cond && eq(v, cond.not)) return false;
      if ('lt' in cond && !(v != null && v < cond.lt)) return false;
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
  rec.updatedAt = tick();
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

function table(store: Rec[], prefix: string, defaults: () => Rec, include?: (r: Rec, inc: Rec) => Rec) {
  const find = (args: Rec = {}) => {
    let l = sortBy(store.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.skip) l = l.slice(args.skip);
    if (args.take) l = l.slice(0, args.take);
    return l.map((r) => (args.include && include ? include({ ...r }, args.include) : { ...r }));
  };
  return {
    store,
    create: jest.fn(async ({ data }: Rec) => {
      const r = { ...defaults(), id: nextId(prefix), createdAt: tick(), updatedAt: tick(), ...data };
      store.push(r);
      return { ...r };
    }),
    createMany: jest.fn(async ({ data }: Rec) => {
      for (const d of data) store.push({ ...defaults(), id: nextId(prefix), createdAt: tick(), updatedAt: tick(), ...d });
      return { count: data.length };
    }),
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
    update: jest.fn(async ({ where, data }: Rec) => {
      const r = store.find((x) => matches(x, where));
      if (!r) throw new Error('Record to update not found');
      applyData(r, data);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: Rec) => {
      const l = store.filter((x) => matches(x, where));
      l.forEach((r) => applyData(r, data));
      return { count: l.length };
    }),
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
    groupBy: jest.fn(async ({ where }: Rec) => {
      const m = new Map<string, Rec>();
      for (const r of store.filter((x) => matches(x, where))) {
        const k = `${r.campaignId}|${r.status}`;
        const g = m.get(k) ?? { campaignId: r.campaignId, status: r.status, _count: { _all: 0 }, _sum: { amountPaise: null } };
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
  const clients: Rec[] = [{ id: 'bajaj', internalName: 'Bajaj Consumer Care', branding: { displayName: 'Bajaj' } }];
  const prisma: Rec = {
    voucherDispersalCampaign: table(campaigns, 'camp', () => ({
      note: null, status: 'DRAFT', sourceFileName: null, uploadedAt: null, uploadedById: null, confirmedById: null,
      confirmedAt: null, cancelledById: null, cancelledAt: null, completedAt: null, billedToClientId: null,
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
        resendCount: 0, attempts: 0,
      }),
      (r, inc) => (inc.campaign ? { ...r, campaign: { ...campaigns.find((c) => c.id === r.campaignId) } } : r),
    ),
    messageDeliveryReceipt: table(receipts, 'rcpt', () => ({ status: 'QUEUED', sentAt: null, deliveredAt: null, readAt: null, failureReason: null })),
    auditLog: table(audits, 'audit', () => ({})),
    client: table(clients, 'client', () => ({})),
    redemptionOrder: { findMany: jest.fn(async () => []) },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: Rec) => Promise<unknown>) => fn(prisma));
  return { prisma, campaigns, rows, receipts, audits, clients };
}
