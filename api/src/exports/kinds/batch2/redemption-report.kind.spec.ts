import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateKey } from '../../../common/ist-date';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import {
  defaultRedemptionRange,
  redemptionWhere,
  type RedemptionReportParams,
} from '../../../reports/redemptions/redemption-report.query';
import {
  hierarchyCells,
  hierarchyHeaders,
  resolveStages,
  type HistoryRow,
  type LevelDef,
  type ReportOrder,
  type SalesNode,
} from '../../../reports/redemptions/redemption-report.rows';
import { ORDER_SELECT, REDEMPTION_REPORT_KIND } from './redemption-report.kind';
import { HUBBLE_NO_ORDER_REASON_TEXT, redactFreeText, safeReasonText } from '../../../reports/redemptions/redemption-report.redact';
import { HUBBLE_NO_ORDER_REFUND_REASON } from '../../../rewards/rewards.service';
import { ctxFor, readBook, renderKind } from './parity.support-spec';

// ─── Users ──────────────────────────────────────────────────────────────────────────────────────────────────────
const BAJAJ_ADMIN = { sub: 'ca-b', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'B admin' } as JwtPayload;
const DEOLEO_ADMIN = { sub: 'ca-d', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: 'D admin' } as JwtPayload;
const GIFSY = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Owner' } as JwtPayload;
const GIFSY_IN_DEOLEO = { ...GIFSY, clientId: 'deoleo', assumed: true } as JwtPayload;

// Clearly-past fixed dates (never a hardcoded future date).
const T0 = Date.UTC(2025, 10, 1, 0, 0, 0) - 330 * 60_000; // 2025-11-01 00:00 IST
const at = (hours: number) => new Date(T0 + hours * 3_600_000);
const NOV: Pick<RedemptionReportParams, 'from' | 'to'> = { from: '2025-11-01', to: '2025-11-30' };

// ─── A tiny in-memory Prisma (nested relation filters, `some`, OR, case-insensitive equals, nested orderBy) ─────────
type Row = Record<string, unknown>;

function matchValue(v: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== 'object') return v === cond;
  const c = cond as Row;
  const ops = ['in', 'not', 'gte', 'lte', 'gt', 'lt', 'equals', 'some'];
  if (!Object.keys(c).some((k) => ops.includes(k))) {
    // A relation filter.
    if (v === null || v === undefined) return false;
    return matches(v as Row, c);
  }
  if ('some' in c) return Array.isArray(v) && v.some((x) => matches(x as Row, c.some as Row));
  if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
  if ('not' in c) {
    if (c.not === null) {
      if (v === null || v === undefined) return false;
    } else if (v === c.not) return false;
  }
  if ('equals' in c) {
    if (typeof v !== 'string') return false;
    if (c.mode === 'insensitive' ? v.toLowerCase() !== String(c.equals).toLowerCase() : v !== c.equals) return false;
  }
  const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
  if ('gte' in c && (v == null || t(v) < t(c.gte))) return false;
  if ('lte' in c && (v == null || t(v) > t(c.lte))) return false;
  return true;
}

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
    } else if (k === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
    } else if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function sortBy(orderBy: unknown) {
  const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
  const get = (r: Row, spec: Row): [unknown, string] => {
    const [k, v] = Object.entries(spec)[0];
    if (typeof v === 'object' && v) return get((r[k] ?? {}) as Row, v as Row);
    return [r[k], v as string];
  };
  return (a: Row, b: Row) => {
    for (const s of specs) {
      const [av, dir] = get(a, s);
      const [bv] = get(b, s);
      const x = av instanceof Date ? av.getTime() : av;
      const y = bv instanceof Date ? bv.getTime() : bv;
      if (x === y) continue;
      const c = (x as never) < (y as never) ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  };
}

function model(rows: Row[], calls: string[], name: string) {
  const list = (args: Row = {}) => {
    calls.push(name);
    let out = rows.filter((r) => matches(r, args.where as Row));
    if (args.orderBy) out = [...out].sort(sortBy(args.orderBy));
    let start = 0;
    if (args.cursor) {
      const i = out.findIndex((r) => r.id === (args.cursor as Row).id);
      start = i < 0 ? out.length : i;
    }
    start += (args.skip as number) ?? 0;
    return out.slice(start, args.take === undefined ? undefined : start + (args.take as number));
  };
  return {
    findMany: jest.fn(async (args?: Row) => list(args)),
    findUnique: jest.fn(async (args: { where: Row }) => {
      calls.push(`${name}.findUnique`);
      return rows.find((r) => matches(r, args.where)) ?? null;
    }),
    count: jest.fn(async (args?: Row) => {
      calls.push(`${name}.count`);
      return rows.filter((r) => matches(r, args?.where as Row)).length;
    }),
  };
}

// ─── World ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface World {
  orders: Row[];
  history: Row[];
  payouts: Row[];
  assignments: Row[];
  salesUsers: Row[];
  levels: Row[];
  users: Row[];
  typeConfigs: Row[];
}

const BAJAJ_LEVELS = ['XSR:ISR', 'SO:SO', 'ASM:ASM', 'RSM:SM', 'ZNM:ZH', 'NSM:NSM'];
const DEOLEO_LEVELS = ['XSR:XSR', 'SO:SO', 'ASM:ASM', 'RSM:RSM', 'ZNM:ZNM', 'NSM:NSM'];

function levelsFor(clientId: string, defs: string[]): Row[] {
  return defs.map((d, i) => {
    const [code, name] = d.split(':');
    return { id: `${clientId}-L${code}`, clientId, code, name, level: i + 1 };
  });
}

function emptyWorld(): World {
  return {
    orders: [],
    history: [],
    payouts: [],
    assignments: [],
    salesUsers: [],
    levels: [...levelsFor('bajaj', BAJAJ_LEVELS), ...levelsFor('deoleo', DEOLEO_LEVELS)],
    users: [
      { id: 'u-member', name: 'Member Mohan' },
      { id: 'u-op', name: 'Operator Olga' },
    ],
    typeConfigs: [{ clientId: 'bajaj', outletTypeId: 'ot-ret', displayName: 'Retailer' }],
  };
}

/** A sales chain for a tenant: ISR → SO → ASM → … (each its own User name). */
function addChain(w: World, clientId: string, prefix: string, opts: { vacant?: string[]; skip?: string[] } = {}) {
  const codes = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'].filter((c) => !opts.skip?.includes(c));
  codes.forEach((code, i) => {
    const vacant = opts.vacant?.includes(code);
    w.salesUsers.push({
      id: `${prefix}-${code}`,
      clientId,
      reportingToId: i + 1 < codes.length ? `${prefix}-${codes[i + 1]}` : null,
      employeeCode: `${code}-${prefix}`,
      hierarchyLevelId: `${clientId}-L${code}`,
      isActive: !vacant,
      deletedAt: null,
      user: vacant ? { name: `(vacant) ${code}-${prefix}`, status: 'INACTIVE' } : { name: `${code} person ${prefix}`, status: 'ACTIVE' },
    });
  });
}

let seq = 0;
function addOrder(w: World, clientId: string, over: Row = {}, outletOver: Row = {}): Row {
  const n = ++seq;
  const outlet = {
    id: `ol-${n}`,
    clientId,
    outletCode: `OC${n}`,
    name: `Shop ${n}`,
    city: 'Pune',
    state: 'Maharashtra',
    zone: 'West',
    programName: 'Gold',
    programCategory: 'Urban',
    outletTypeId: 'ot-ret',
    outletType: { name: 'Retail outlet', code: 'RETAILER' },
    isPrimary: true,
    isActive: true,
    createdAt: at(-1000),
    deletedAt: null,
    ...outletOver,
  };
  const order: Row = {
    id: `o-${String(n).padStart(6, '0')}`,
    orderNumber: `${clientId.toUpperCase()}-25-${n}`,
    partnerId: `p-${n}`,
    status: 'DELIVERED',
    quantity: 1,
    pointsDeducted: 500,
    totalPointsCost: 500,
    valuePaise: 50_000n,
    redemptionMode: 'PHYSICAL_GIFT',
    fulfilmentChannel: 'GIFSY_WAREHOUSE',
    deliveryCity: 'Pune',
    deliveryState: 'Maharashtra',
    deliveryPincode: '411001',
    trackingNumber: `TRK${n}`,
    logisticsPartner: 'BlueDart',
    voucherProvider: null,
    podUrl: 'https://files.example/pod.pdf',
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    cancelReason: null,
    metadata: null,
    createdAt: at(10 + n / 1000),
    // Secrets the report must NEVER output (the fake ignores `select`, so they reach the row builder).
    voucherCode: 'VC-SECRET-CODE',
    voucherPin: 'PIN-SECRET-9911',
    payeePan: 'ABCPE1234X',
    deliveryName: 'Secret Ship Name',
    deliveryPhone: '9123498765',
    deliveryAddressLine1: '12 Secret Street',
    deliveryAddressLine2: 'Hidden Lane',
    reward: { name: 'Steel Bottle', metadata: { brand: 'Milton' }, category: { name: 'Kitchen' } },
    fulfilledByVendor: null,
    partner: {
      id: `p-${n}`,
      clientId,
      userId: 'u-member',
      ownerName: `Owner ${n}`,
      businessName: `Biz ${n}`,
      phone: '9876543210',
      panNumber: 'PANSECRET1',
      bankAccountNumber: '000111222333',
      user: { name: 'Member Mohan', role: 'WHOLESALER' },
      outlets: [outlet],
    },
    ...over,
  };
  w.orders.push(order);
  return order;
}

function hist(w: World, order: Row, rows: Array<[string | null, string, number, string | null, string?]>) {
  for (const [from, to, h, by, notes] of rows) {
    w.history.push({
      id: `h-${++seq}`,
      orderId: order.id,
      order,
      fromStatus: from,
      toStatus: to,
      changedById: by,
      notes: notes ?? null,
      createdAt: at(h),
    });
  }
}

function assign(w: World, order: Row, salesUserId: string, clientId: string) {
  const outlet = (order.partner as Row & { outlets: Row[] }).outlets[0];
  w.assignments.push({
    id: `a-${++seq}`,
    outletId: outlet.id,
    partnerId: null,
    salesUserId,
    unassignedAt: null,
    assignedAt: at(0),
    salesUser: { clientId },
  });
}

function prismaFor(w: World) {
  const calls: string[] = [];
  const audit = jest.fn(async () => ({}));
  // Outlets as Prisma sees them (owner partner + its orders, for the primary-outlet zone/state filter).
  const outlets = new Map<string, Row>();
  for (const o of w.orders) {
    const partner = o.partner as Row & { outlets: Row[]; clientId: string; id: string };
    for (const x of partner.outlets) {
      outlets.set(x.id as string, {
        ...x,
        partnerId: partner.id,
        partner: { clientId: partner.clientId, redemptionOrders: w.orders.filter((y) => (y.partner as Row).id === partner.id) },
      });
    }
  }
  const prisma: Row = {
    outlet: model([...outlets.values()], calls, 'outlet'),
    client: model([{ id: 'bajaj' }, { id: 'deoleo' }], calls, 'client'),
    redemptionOrder: model(w.orders, calls, 'redemptionOrder'),
    redemptionStatusHistory: model(w.history, calls, 'redemptionStatusHistory'),
    payoutTransaction: model(w.payouts, calls, 'payoutTransaction'),
    salesUserAssignment: model(w.assignments, calls, 'salesUserAssignment'),
    salesUser: model(w.salesUsers, calls, 'salesUser'),
    salesHierarchyLevel: model(w.levels, calls, 'salesHierarchyLevel'),
    outletTypeClientConfig: model(w.typeConfigs, calls, 'outletTypeClientConfig'),
    user: model(w.users, calls, 'user'),
    auditLog: { create: audit },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma, calls, audit };
}

/** Captures every sheet as plain arrays (fast — no xlsx encoding). */
function captureWriter() {
  const sheets: Record<string, { headers: string[]; rows: XlsxCell[][] }> = {};
  const order: string[] = [];
  const w: XlsxStreamWriter = {
    async addSheet(name, headers) {
      const s = { headers: [...headers], rows: [] as XlsxCell[][] };
      sheets[name] = s;
      order.push(name);
      return {
        async addRow(cells) {
          s.rows.push([...cells]);
        },
        get rowCount() {
          return s.rows.length;
        },
      };
    },
    async finish() {},
    get rowCount() {
      return 0;
    },
  };
  return { w, sheets, order };
}

async function exportAs(user: JwtPayload, w: World, raw: Row = {}, now = at(24 * 40)) {
  const params = REDEMPTION_REPORT_KIND.parseParams({ ...NOV, ...raw }, user);
  const { prisma, calls, audit } = prismaFor(w);
  const cap = captureWriter();
  const res = await REDEMPTION_REPORT_KIND.run(ctxFor(user, prisma, [], now), params, cap.w);
  const rs = cap.sheets.Redemptions;
  const col = (h: string) => rs.headers.indexOf(h);
  const rowOf = (orderNo: string) => rs.rows.find((r) => r[0] === orderNo)!;
  const cell = (orderNo: string, h: string) => {
    const i = col(h);
    if (i < 0) throw new Error(`no column "${h}"`);
    return rowOf(orderNo)[i];
  };
  return { res, cap, calls, audit, rs, cell, params };
}

beforeEach(() => {
  seq = 0;
});

// ─── Tenant isolation ───────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — tenant isolation', () => {
  function twoTenants() {
    const w = emptyWorld();
    for (let i = 0; i < 3; i++) addOrder(w, 'bajaj');
    for (let i = 0; i < 2; i++) addOrder(w, 'deoleo');
    return w;
  }

  it('a client admin is pinned to their own tenant (?clientId= of another tenant is ignored)', async () => {
    const { rs, params } = await exportAs(BAJAJ_ADMIN, twoTenants(), { clientId: 'deoleo' });
    expect(params.clientId).toBe('bajaj');
    expect(rs.rows).toHaveLength(3);
    expect(rs.rows.every((r) => String(r[0]).startsWith('BAJAJ-'))).toBe(true);
  });

  it('a stored request whose clientId was tampered is re-pinned to the requester at run time', async () => {
    const w = twoTenants();
    const { prisma } = prismaFor(w);
    const cap = captureWriter();
    const tampered = { ...REDEMPTION_REPORT_KIND.parseParams(NOV, DEOLEO_ADMIN), clientId: 'bajaj' };
    await REDEMPTION_REPORT_KIND.run(ctxFor(DEOLEO_ADMIN, prisma, [], at(24 * 40)), tampered, cap.w);
    expect(cap.sheets.Redemptions.rows).toHaveLength(2);
    expect(cap.sheets.Redemptions.rows.every((r) => String(r[0]).startsWith('DEOLEO-'))).toBe(true);
  });

  it('an ASSUMED Gifsy operator is pinned to the assumed tenant', async () => {
    const { rs, params } = await exportAs(GIFSY_IN_DEOLEO, twoTenants(), { clientId: 'bajaj' });
    expect(params.clientId).toBe('deoleo');
    expect(rs.rows).toHaveLength(2);
  });

  it('an un-assumed Gifsy owner must choose a client; with ?clientId= gets only that client', async () => {
    expect(() => REDEMPTION_REPORT_KIND.parseParams(NOV, GIFSY)).toThrow(BadRequestException);
    const { rs } = await exportAs(GIFSY, twoTenants(), { clientId: 'bajaj' });
    expect(rs.rows).toHaveLength(3);
  });

  it('hierarchy, assignments and levels never come from another tenant', async () => {
    const w = emptyWorld();
    addChain(w, 'deoleo', 'D');
    const o = addOrder(w, 'bajaj');
    // A (corrupt) assignment of a bajaj outlet to a deoleo rep must not surface the deoleo chain.
    assign(w, o, 'D-XSR', 'deoleo');
    const { cell, rs } = await exportAs(BAJAJ_ADMIN, w);
    expect(cell(o.orderNumber as string, 'ISR')).toBe('Not assigned');
    expect(rs.headers).not.toContain('XSR'); // bajaj level names, not deoleo's
  });

  it('access: GIFSY_ADMIN + CLIENT_ADMIN with reports:read (no MIS_USER — payments-report precedent)', () => {
    expect(REDEMPTION_REPORT_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:read' });
  });
});

// ─── Secrets ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — never-exported data', () => {
  const FORBIDDEN_KEYS = [
    'voucherCode',
    'voucherPin',
    'payeePan',
    'panNumber',
    'deliveryName',
    'deliveryPhone',
    'deliveryAddressLine1',
    'deliveryAddressLine2',
    'bankAccountNumber',
    'ifscCode',
    'upiId',
  ];

  function keysDeep(o: unknown, acc: string[] = []): string[] {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        acc.push(k);
        keysDeep(v, acc);
      }
    }
    return acc;
  }

  it('the order SELECT never names a secret column', () => {
    const keys = keysDeep(ORDER_SELECT);
    for (const k of FORBIDDEN_KEYS) expect(keys).not.toContain(k);
  });

  it('no sheet ever contains a voucher code / PIN / PAN / full phone / address line, even if the rows carry them', async () => {
    const w = emptyWorld();
    const ev = addOrder(w, 'bajaj', { redemptionMode: 'GIFT_CARD', fulfilmentChannel: 'DIGITAL_VOUCHER', voucherProvider: 'Hubble' });
    const cash = addOrder(w, 'bajaj', { redemptionMode: 'UPI', fulfilmentChannel: null });
    addOrder(w, 'bajaj');
    hist(w, ev, [['PENDING', 'CONFIRMED', 11, 'u-member', 'code VC is sent by SMS']]);
    w.payouts.push({ redemptionOrderId: cash.id, status: 'SUCCESS', completedAt: at(30), providerRefId: 'UTR123', tdsPaise: 0n, createdAt: at(30), id: 'pt1', bankAccountNumber: '000111222333' });
    const { cap } = await exportAs(BAJAJ_ADMIN, w);
    const dump = JSON.stringify(Object.values(cap.sheets), (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    for (const secret of ['VC-SECRET-CODE', 'PIN-SECRET-9911', 'ABCPE1234X', 'PANSECRET1', '9876543210', '9123498765', '12 Secret Street', 'Hidden Lane', 'Secret Ship Name', '000111222333']) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain('XXXXXX3210');
  });

  // OWNER RULE (2026-11-26): no downloaded file names the voucher fulfiller — whoever generates it (a client
  // admin, or Gifsy staff whose download may be forwarded to the client).
  it.each([['client admin', BAJAJ_ADMIN], ['Gifsy admin', GIFSY]])(
    'a real workbook generated by a %s contains no "hubble" anywhere (any case, any sheet)',
    async (_who, user) => {
      const w = emptyWorld();
      const ok = addOrder(w, 'bajaj', { redemptionMode: 'GIFT_CARD', fulfilmentChannel: 'DIGITAL_VOUCHER', voucherProvider: 'Hubble' });
      hist(w, ok, [
        ['PENDING', 'CONFIRMED', 1, 'u-member'],
        ['CONFIRMED', 'PROCESSING', 2, null, 'Hubble voucher processing (auto re-check)'],
        ['PROCESSING', 'DELIVERED', 3, null, 'Hubble voucher issued (Hubble webhook)'],
      ]);
      const failed = addOrder(w, 'bajaj', {
        redemptionMode: 'GIFT_CARD', voucherProvider: 'hubble', status: 'FAILED', pointsDeducted: 0,
        cancelReason: 'Hubble issuance failed: Hubble said ERR_42 for this Hubble order',
      });
      hist(w, failed, [['CONFIRMED', 'FAILED', 4, null, 'Hubble failed — points refunded: HUBBLE timeout']]);
      const noOrder = addOrder(w, 'bajaj', { redemptionMode: 'GIFT_CARD', voucherProvider: null, status: 'FAILED', pointsDeducted: 0, cancelReason: HUBBLE_NO_ORDER_REFUND_REASON });
      hist(w, noOrder, [['CONFIRMED', 'FAILED', 5, null, `Hubble issuance failed: ${HUBBLE_NO_ORDER_REFUND_REASON}`]]);
      // A typed REASON / note that names the fulfiller is reason text → neutral words too.
      const typed = addOrder(w, 'bajaj', { status: 'CANCELLED', pointsDeducted: 0, cancelReason: 'Checked with Hubble — cancelled' });
      hist(w, typed, [['PENDING', 'CANCELLED', 6, 'u-op', 'Checked with Hubble — cancelled']]);
      const params = REDEMPTION_REPORT_KIND.parseParams(user === GIFSY ? { ...NOV, clientId: 'bajaj' } : NOV, user);
      const { prisma } = prismaFor(w);
      const { buffer, rowCount } = await renderKind(REDEMPTION_REPORT_KIND, ctxFor(user, prisma, [], at(24 * 40)), params);
      expect(rowCount).toBe(4);
      const book = readBook(buffer);
      const dump = JSON.stringify(book);
      expect(dump).not.toMatch(/hubble/i);
      const head = book.sheets.Redemptions.aoa[0] as string[];
      const row = book.sheets.Redemptions.aoa.find((r) => r[0] === ok.orderNumber)!;
      expect(row[head.indexOf('Fulfilled by')]).toBe('Via API');
    },
    30_000,
  );

  it('real data that merely CONTAINS the word (a reward / outlet / category name) passes through UNCHANGED', async () => {
    const w = emptyWorld();
    const o = addOrder(w, 'bajaj', { reward: { name: 'Hubble Amazon Pay', metadata: null, category: { name: 'Hubble cards' } } }, { name: 'Hubble Traders' });
    const params = REDEMPTION_REPORT_KIND.parseParams(NOV, BAJAJ_ADMIN);
    const { prisma } = prismaFor(w);
    const { buffer } = await renderKind(REDEMPTION_REPORT_KIND, ctxFor(BAJAJ_ADMIN, prisma, [], at(24 * 40)), params);
    const book = readBook(buffer);
    const head = book.sheets.Redemptions.aoa[0] as string[];
    const row = book.sheets.Redemptions.aoa.find((r) => r[0] === o.orderNumber)!;
    expect(row[head.indexOf('Reward')]).toBe('Hubble Amazon Pay');
    expect(JSON.stringify(row)).toContain('Hubble Traders');
    expect(JSON.stringify(row)).toContain('Hubble cards');
  }, 30_000);

  it('a real workbook builds (all four sheets, POD hyperlink, formula-safe text)', async () => {
    const w = emptyWorld();
    addOrder(w, 'bajaj', { reward: { name: '=HYPERLINK("x")', metadata: null, category: { name: 'K' } } });
    const params = REDEMPTION_REPORT_KIND.parseParams(NOV, BAJAJ_ADMIN);
    const { prisma } = prismaFor(w);
    const { buffer, rowCount } = await renderKind(REDEMPTION_REPORT_KIND, ctxFor(BAJAJ_ADMIN, prisma, [], at(24 * 40)), params);
    expect(rowCount).toBe(1);
    const book = readBook(buffer);
    expect(book.names).toEqual(['Redemptions', 'Status history', 'Summary', 'About']);
    const head = book.sheets.Redemptions.aoa[0] as string[];
    const row = book.sheets.Redemptions.aoa[1];
    expect(row[head.indexOf('Reward')]).toBe(`'=HYPERLINK("x")`);
    expect(row[head.indexOf('Proof of delivery')]).toBe('Yes — open');
  }, 30_000);
});

// ─── Stages ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — stage timestamps', () => {
  const names = (id: string | null) => (id === 'u-op' ? 'Operator Olga' : id === 'u-member' ? 'Member Mohan' : 'Not recorded');
  const base = (over: Partial<ReportOrder> = {}): ReportOrder =>
    ({
      id: 'o1',
      status: 'DELIVERED',
      createdAt: at(1),
      dispatchedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      cancelReason: null,
      metadata: null,
      partner: { userId: 'u-member' },
      ...over,
    }) as ReportOrder;
  const h = (to: string, hours: number, by: string | null = 'u-op', from: string | null = null, notes: string | null = null): HistoryRow =>
    ({ id: `h${hours}`, orderId: 'o1', fromStatus: from, toStatus: to, changedById: by, notes, createdAt: at(hours) }) as HistoryRow;

  it('a skipped stage reads "Skipped" (cash: Placed → Delivered)', () => {
    const s = resolveStages(base(), [h('CONFIRMED', 2, 'u-member'), h('DELIVERED', 30, 'u-op')], names);
    expect(s.confirmed.at).toEqual(at(2));
    expect(s.confirmed.by).toBe('Member Mohan');
    expect(s.processing.when).toBe('Skipped');
    expect(s.dispatched.when).toBe('Skipped');
    expect(s.delivered).toMatchObject({ at: at(30), by: 'Operator Olga' });
    expect(s.placed).toMatchObject({ at: at(1), by: 'Member Mohan' });
  });

  it('a re-entered stage keeps the FIRST time it was entered; "days in current stage" uses the LAST entry', () => {
    const order = base({ status: 'DISPATCHED' });
    const rows = [h('CONFIRMED', 2), h('DISPATCHED', 5), h('PROCESSING', 7), h('DISPATCHED', 9, null)];
    const s = resolveStages(order, rows, names);
    expect(s.dispatched).toMatchObject({ at: at(5), by: 'Operator Olga' });
    expect(s.processing.at).toEqual(at(7));
    expect(s.enteredCurrentAt).toEqual(at(9));
    expect(s.delivered.when).toBe('—'); // not reached yet
  });

  it('missing history falls back to the order stamps with "by" = Not recorded; history-less gaps read Not recorded', () => {
    const s = resolveStages(base({ dispatchedAt: at(20), deliveredAt: at(40) }), [], names);
    expect(s.dispatched).toMatchObject({ at: at(20), by: 'Not recorded' });
    expect(s.delivered).toMatchObject({ at: at(40), by: 'Not recorded' });
    expect(s.confirmed.when).toBe('Not recorded');
  });

  it('a "System" change has no actor; a cancelled order shows its time, actor and reason', () => {
    const s = resolveStages(
      base({ status: 'CANCELLED', cancelledAt: at(3), cancelReason: null }),
      [h('CANCELLED', 3, null, 'PENDING', 'Superseded — OTP not completed')],
      names,
    );
    expect(s.closed).toMatchObject({ at: at(3), by: 'System' });
    expect(s.closedReason).toBe('Cancelled: OTP not completed — replaced by a newer order');
    expect(s.confirmed.when).toBe('—');
  });

  it('a rep-staged order is "Placed by" the rep', () => {
    const s = resolveStages(base({ metadata: { salesInitiatedById: 'u-op' } }), [], names);
    expect(s.placed.by).toBe('Operator Olga');
  });

  it('end to end: stage columns + days placed → delivered + status history sheet', async () => {
    const w = emptyWorld();
    const o = addOrder(w, 'bajaj', { createdAt: at(0), status: 'DELIVERED', dispatchedAt: at(24), deliveredAt: at(60) });
    hist(w, o, [
      ['PENDING', 'CONFIRMED', 1, 'u-member'],
      ['CONFIRMED', 'DISPATCHED', 24, 'u-op'],
      ['DISPATCHED', 'DELIVERED', 60, null, 'POD uploaded'],
    ]);
    const { cell, cap } = await exportAs(BAJAJ_ADMIN, w);
    const no = o.orderNumber as string;
    expect(cell(no, 'Placed (IST)')).toBe('2025-11-01 00:00');
    expect(cell(no, 'Processing (IST)')).toBe('Skipped');
    expect(cell(no, 'Dispatched by')).toBe('Operator Olga');
    expect(cell(no, 'Delivered by')).toBe('System');
    expect(cell(no, 'Days placed → delivered')).toBe(2.5);
    const sh = cap.sheets['Status history'];
    expect(sh.headers).toEqual(['Order no', 'Outlet code', 'From', 'To', 'When (IST)', 'By', 'Notes']);
    expect(sh.rows).toEqual([
      [no, 'OC1', 'Placed', 'Confirmed', '2025-11-01 01:00', 'Member Mohan', '—'],
      [no, 'OC1', 'Confirmed', 'Dispatched', '2025-11-02 00:00', 'Operator Olga', '—'],
      [no, 'OC1', 'Dispatched', 'Delivered', '2025-11-03 12:00', 'System', 'POD uploaded'],
    ]);
  });
});

// ─── Hierarchy ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — hierarchy columns', () => {
  const lv = (clientId: string, defs: string[]): LevelDef[] => levelsFor(clientId, defs) as unknown as LevelDef[];

  it('Bajaj-like and Deoleo-like tenants get their OWN level names as headers, lowest first', () => {
    expect(hierarchyHeaders({ clientId: 'bajaj', levels: lv('bajaj', BAJAJ_LEVELS) })).toEqual([
      'ISR', 'ISR code', 'SO', 'SO code', 'ASM', 'ASM code', 'SM', 'SM code', 'ZH', 'ZH code', 'NSM', 'NSM code',
    ]);
    expect(hierarchyHeaders({ clientId: 'deoleo', levels: lv('deoleo', DEOLEO_LEVELS) })).toEqual([
      'XSR', 'XSR code', 'SO', 'SO code', 'ASM', 'ASM code', 'RSM', 'RSM code', 'ZNM', 'ZNM code', 'NSM', 'NSM code',
    ]);
    // A level with no name falls back to the code's display label (Bajaj: RSM → SM).
    const unnamed = lv('bajaj', ['RSM:']).map((l) => ({ ...l, name: null }));
    expect(hierarchyHeaders({ clientId: 'bajaj', levels: unnamed })).toEqual(['SM', 'SM code']);
  });

  function ctx(w: World, clientId: string) {
    return {
      clientId,
      levels: (w.levels.filter((l) => l.clientId === clientId) as unknown) as LevelDef[],
      nodes: new Map((w.salesUsers as unknown as SalesNode[]).map((n) => [n.id, n])),
    };
  }

  it('full chain, vacant post, skipped level, no rep', () => {
    const w = emptyWorld();
    addChain(w, 'bajaj', 'B', { vacant: ['SO'] });
    addChain(w, 'bajaj', 'C', { skip: ['SO'] });
    const c = ctx(w, 'bajaj');
    expect(hierarchyCells('B-XSR', c)).toEqual([
      'XSR person B', 'XSR-B', 'Vacant (SO-B)', 'SO-B', 'ASM person B', 'ASM-B', 'RSM person B', 'RSM-B', 'ZNM person B', 'ZNM-B', 'NSM person B', 'NSM-B',
    ]);
    const skipped = hierarchyCells('C-XSR', c);
    expect(skipped.slice(2, 4)).toEqual(['—', '—']);
    expect(skipped.slice(4, 6)).toEqual(['ASM person C', 'ASM-C']);
    expect(hierarchyCells(null, c)).toEqual(Array(12).fill('Not assigned'));
  });

  it('a reporting-line cycle terminates', () => {
    const w = emptyWorld();
    addChain(w, 'deoleo', 'L');
    (w.salesUsers.find((s) => s.id === 'L-NSM') as Row).reportingToId = 'L-XSR';
    expect(hierarchyCells('L-XSR', ctx(w, 'deoleo'))).toHaveLength(12);
  });

  it('end to end (Deoleo-like): assigned rep chain + partner with no assigned rep + Summary by ASM', async () => {
    const w = emptyWorld();
    addChain(w, 'deoleo', 'D');
    const withRep = addOrder(w, 'deoleo');
    const noRep = addOrder(w, 'deoleo');
    assign(w, withRep, 'D-XSR', 'deoleo');
    const { cell, rs, cap } = await exportAs(DEOLEO_ADMIN, w);
    expect(rs.headers.slice(23, 35)).toEqual(['XSR', 'XSR code', 'SO', 'SO code', 'ASM', 'ASM code', 'RSM', 'RSM code', 'ZNM', 'ZNM code', 'NSM', 'NSM code']);
    expect(cell(withRep.orderNumber as string, 'ASM')).toBe('ASM person D');
    expect(cell(withRep.orderNumber as string, 'NSM code')).toBe('NSM-D');
    expect(cell(noRep.orderNumber as string, 'XSR')).toBe('Not assigned');
    expect(cell(noRep.orderNumber as string, 'NSM code')).toBe('Not assigned');
    const byAsm = cap.sheets.Summary.rows.filter((r) => r[0] === 'By ASM').map((r) => r[1]);
    expect(byAsm.sort()).toEqual(['ASM person D (ASM-D)', 'Not assigned']);
  });
});

// ─── Query count ────────────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — query count', () => {
  function world(n: number): World {
    const w = emptyWorld();
    addChain(w, 'bajaj', 'Q');
    for (let i = 0; i < n; i++) {
      const o = addOrder(w, 'bajaj', { redemptionMode: i % 3 ? 'PHYSICAL_GIFT' : 'UPI' });
      hist(w, o, [['PENDING', 'CONFIRMED', 11, i % 2 ? 'u-member' : 'u-op']]);
      if (i % 2) assign(w, o, 'Q-XSR', 'bajaj');
      if (!(i % 3)) w.payouts.push({ id: `pt${i}`, redemptionOrderId: o.id, status: 'PENDING', completedAt: null, providerRefId: null, tdsPaise: 0n, createdAt: at(12) });
    }
    return w;
  }

  it('is the same for 20 orders and for 2,000 orders (no per-row queries)', async () => {
    const small = await exportAs(BAJAJ_ADMIN, world(20));
    const big = await exportAs(BAJAJ_ADMIN, world(2000));
    expect(big.rs.rows).toHaveLength(2000);
    expect(big.cap.sheets['Status history'].rows).toHaveLength(2000);
    expect(big.calls).toEqual(small.calls);
    expect(big.calls.length).toBeLessThanOrEqual(12);
  }, 60_000);
});

// ─── Filters + IST dates ────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — filters and IST date boundaries', () => {
  it('status, reward type, zone and state filters (case-insensitive)', async () => {
    const w = emptyWorld();
    const gift = addOrder(w, 'bajaj', { status: 'DISPATCHED' }, { zone: 'North', state: 'Punjab' });
    const cash = addOrder(w, 'bajaj', { redemptionMode: 'BANK_TRANSFER', fulfilmentChannel: null });
    const voucher = addOrder(w, 'bajaj', { redemptionMode: 'GIFT_CARD', fulfilmentChannel: null, voucherProvider: 'Hubble' });
    const digitalGift = addOrder(w, 'bajaj', { redemptionMode: 'PHYSICAL_GIFT', fulfilmentChannel: 'DIGITAL_VOUCHER' });
    const nos = async (raw: Row) => (await exportAs(BAJAJ_ADMIN, w, raw)).rs.rows.map((r) => r[0]).sort();
    expect(await nos({ status: 'DISPATCHED' })).toEqual([gift.orderNumber]);
    expect(await nos({ rewardType: 'CASH' })).toEqual([cash.orderNumber]);
    expect(await nos({ rewardType: 'E_VOUCHER' })).toEqual([voucher.orderNumber, digitalGift.orderNumber].sort());
    expect(await nos({ rewardType: 'PHYSICAL_GIFT' })).toEqual([gift.orderNumber]);
    expect(await nos({ zone: 'north' })).toEqual([gift.orderNumber]);
    expect(await nos({ state: 'PUNJAB' })).toEqual([gift.orderNumber]);
    expect(() => REDEMPTION_REPORT_KIND.parseParams({ ...NOV, rewardType: 'POINTS' }, BAJAJ_ADMIN)).toThrow(BadRequestException);
    expect(() => REDEMPTION_REPORT_KIND.parseParams({ from: '2025-11-30', to: '2025-11-01' }, BAJAJ_ADMIN)).toThrow(BadRequestException);
    expect(() => REDEMPTION_REPORT_KIND.parseParams({ from: '2025-02-31', to: '2025-03-01' }, BAJAJ_ADMIN)).toThrow(BadRequestException);
  });

  it('the IST day boundary: 23:59 IST on the 31st is out, 00:00 IST on the 1st is in (and printed in IST)', async () => {
    const w = emptyWorld();
    const before = addOrder(w, 'bajaj', { createdAt: new Date(T0 - 1000) }); // 2025-10-31 23:59:59 IST
    const first = addOrder(w, 'bajaj', { createdAt: new Date(T0) }); // 2025-11-01 00:00 IST (= 2025-10-31 18:30 UTC)
    const last = addOrder(w, 'bajaj', { createdAt: new Date(T0 + 30 * 86_400_000 - 1000) }); // 2025-11-30 23:59:59 IST
    const after = addOrder(w, 'bajaj', { createdAt: new Date(T0 + 30 * 86_400_000) }); // 2025-12-01 00:00 IST
    const { rs, cell } = await exportAs(BAJAJ_ADMIN, w);
    const nos = rs.rows.map((r) => r[0]);
    expect(nos).toEqual([first.orderNumber, last.orderNumber]);
    expect(nos).not.toContain(before.orderNumber);
    expect(nos).not.toContain(after.orderNumber);
    expect(cell(first.orderNumber as string, 'Redeemed on (IST)')).toBe('2025-11-01 00:00');
    expect(cell(last.orderNumber as string, 'Redeemed on (IST)')).toBe('2025-11-30 23:59');
  });

  it('defaults to the current IST month (computed relative to now)', () => {
    const now = new Date();
    const r = defaultRedemptionRange(now);
    expect(r.to).toBe(istDateKey(now));
    expect(r.from).toBe(`${istDateKey(now).slice(0, 7)}-01`);
    const p = REDEMPTION_REPORT_KIND.parseParams({}, BAJAJ_ADMIN);
    expect(p.from).toBe(r.from);
    // 00:30 IST on the 1st is still that IST month (UTC is the previous day).
    const firstIst = new Date(Date.UTC(2025, 9, 31, 19, 0));
    expect(defaultRedemptionRange(firstIst)).toEqual({ from: '2025-11-01', to: '2025-11-01' });
  });

  it('where: tenant on the partner, IST-day createdAt bounds', () => {
    const where = redemptionWhere({ clientId: 'bajaj', from: '2025-11-01', to: '2025-11-30', status: null, rewardType: null, zone: null, state: null });
    expect(where.partner).toEqual({ clientId: 'bajaj' });
    expect(where.createdAt).toEqual({ gte: new Date(T0), lte: new Date(T0 + 30 * 86_400_000 - 1) });
  });

  it('≤ 31 days streams, longer ranges are prepared in the background', () => {
    const p = (from: string, to: string) => REDEMPTION_REPORT_KIND.parseParams({ from, to }, BAJAJ_ADMIN);
    expect(REDEMPTION_REPORT_KIND.isHeavy(p('2025-10-01', '2025-10-31'))).toBe(false);
    expect(REDEMPTION_REPORT_KIND.isHeavy(p('2025-10-01', '2025-11-01'))).toBe(true);
  });
});

// ─── Rows, placeholders, audit ──────────────────────────────────────────────────────────────────────────────────
describe('redemption report — row values, placeholders and audit', () => {
  it('cash payout bridge, e-voucher provider, physical-only columns, Not set / Not recorded / —', async () => {
    const w = emptyWorld();
    const cash = addOrder(w, 'bajaj', { redemptionMode: 'UPI', fulfilmentChannel: null, status: 'DELIVERED', deliveredAt: at(48) });
    w.payouts.push({ id: 'p-old', redemptionOrderId: cash.id, status: 'FAILED', completedAt: null, providerRefId: null, tdsPaise: 0n, createdAt: at(20) });
    w.payouts.push({ id: 'p-new', redemptionOrderId: cash.id, status: 'SUCCESS', completedAt: at(48), providerRefId: 'UTR777', tdsPaise: 1500n, createdAt: at(30) });
    const ev = addOrder(w, 'bajaj', { redemptionMode: 'GIFT_CARD', fulfilmentChannel: null, voucherProvider: 'Hubble', status: 'PENDING', valuePaise: null, pointsDeducted: 0 });
    const bare = addOrder(w, 'bajaj', { logisticsPartner: null, trackingNumber: null, podUrl: null, reward: { name: 'Bag', metadata: null, category: null } }, { zone: null, programName: null });
    const { cell, audit, cap } = await exportAs(BAJAJ_ADMIN, w);
    const c = cash.orderNumber as string;
    expect(cell(c, 'Type')).toBe('Cash / UPI');
    expect(cell(c, 'Payout status')).toBe('Paid');
    expect(cell(c, 'Paid on (IST)')).toBe('2025-11-03 00:00');
    expect(cell(c, 'Bank reference (UTR)')).toBe('UTR777');
    expect(cell(c, 'TDS deducted (₹)')).toBe(15);
    expect(cell(c, 'Courier')).toBe('—');
    expect(cell(c, 'Role')).toBe('Retailer');
    const e = ev.orderNumber as string;
    expect(cell(e, 'Type')).toBe('E-voucher');
    expect(cell(e, 'Fulfilled by')).toBe('Via API'); // owner rule 2026-11-26: the fulfiller is never named
    expect(cell(e, 'Current status')).toBe('Placed');
    expect(cell(e, 'Value (₹)')).toBe(0); // nothing deducted → no value (consistent with Points deducted)
    expect(cell(e, 'Points deducted')).toBe(0);
    expect(cell(e, 'Points requested')).toBe(500);
    expect(cell(e, 'TDS deducted (₹)')).toBe('—');
    expect(cell(e, 'Bank reference (UTR)')).toBe('—');
    const b = bare.orderNumber as string;
    expect(cell(b, 'Courier')).toBe('Not recorded');
    expect(cell(b, 'Proof of delivery')).toBe('No');
    expect(cell(b, 'Zone')).toBe('Not set');
    expect(cell(b, 'Programme')).toBe('Not set');
    expect(cell(b, 'Brand')).toBe('Not recorded');
    expect(cell(b, 'Category')).toBe('Not recorded');
    // No silent blanks anywhere in the Redemptions sheet.
    for (const r of cap.sheets.Redemptions.rows) for (const v of r) expect(v === '' || v === null || v === undefined).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ action: 'EXPORT', entityType: 'REDEMPTION_REPORT', entityId: 'bajaj', actorId: 'ca-b' }) }),
    ]);
    const about = cap.sheets.About.rows.map((r) => r[0]);
    expect(about).toEqual(expect.arrayContaining(['Not recorded', 'Not set', '—', 'Skipped', 'Not assigned', 'Generated (IST)', 'Never included']));
    const summary = cap.sheets.Summary.rows;
    expect(summary[0]).toEqual(['Total', 'All orders in this file', 3, 1000, 1000, 1500, 2, expect.any(Number)]);
  });

  it('0 matching orders → 404 and no audit row', async () => {
    const w = emptyWorld();
    addOrder(w, 'deoleo');
    const params = REDEMPTION_REPORT_KIND.parseParams(NOV, BAJAJ_ADMIN);
    const { prisma, audit } = prismaFor(w);
    await expect(REDEMPTION_REPORT_KIND.run(ctxFor(BAJAJ_ADMIN, prisma, []), params, captureWriter().w)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit).not.toHaveBeenCalled();
  });
});

// ─── Audit fix round ────────────────────────────────────────────────────────────────────────────────────────────
describe('redemption report — audit fixes', () => {
  const NOTE = 'Vendor said code AB12CD34EF / 4321-8765-0000 rejected; call 98765 43210 or ops@vendor.in, PAN ABCPE1234X';

  it('free text is redacted: codes, grouped codes, phones, e-mails, PANs, links', () => {
    const out = redactFreeText(`${NOTE} see https://x.example/t?code=1`);
    for (const secret of ['AB12CD34EF', '4321-8765-0000', '98765 43210', 'ops@vendor.in', 'ABCPE1234X', 'https://']) expect(out).not.toContain(secret);
    expect(out).toContain('[removed]');
    expect(out).toContain('Vendor said code');
    // Plain words survive (no digit → not a code), short numbers too.
    expect(redactFreeText('Customer cancelled, wrong address, 2 items')).toBe('Customer cancelled, wrong address, 2 items');
    // Platform reasons → fixed plain words; a provider-error tail is dropped entirely.
    expect(safeReasonText('Superseded — OTP not completed')).toBe('OTP not completed — replaced by a newer order');
    expect(safeReasonText('Hubble failed — points refunded: card VCX99887766 out of stock')).toBe('E-voucher could not be issued — points refunded');
    expect(HUBBLE_NO_ORDER_REASON_TEXT).toBe(HUBBLE_NO_ORDER_REFUND_REASON);
  });

  it('neither the reason column nor the Status history sheet exports raw notes', async () => {
    const w = emptyWorld();
    const o = addOrder(w, 'bajaj', { status: 'CANCELLED', cancelledAt: at(3), cancelReason: NOTE, pointsDeducted: 0 });
    hist(w, o, [['CONFIRMED', 'CANCELLED', 3, 'u-op', NOTE]]);
    const { cap, cell } = await exportAs(BAJAJ_ADMIN, w);
    const dump = JSON.stringify(cap.sheets);
    for (const secret of ['AB12CD34EF', '4321-8765-0000', '98765 43210', 'ops@vendor.in', 'ABCPE1234X']) expect(dump).not.toContain(secret);
    expect(String(cell(o.orderNumber as string, 'Cancel/return/fail reason'))).toMatch(/^Cancelled: Vendor said code \[removed\]/);
    expect(String(cap.sheets['Status history'].rows[0][6])).toContain('[removed]');
  });

  it('Points deducted / requested; Value follows Points deducted; Summary totals == the sum of the rows', async () => {
    const w = emptyWorld();
    addOrder(w, 'bajaj', { pointsDeducted: 500, totalPointsCost: 500, valuePaise: 50_000n });
    addOrder(w, 'bajaj', { status: 'CANCELLED', pointsDeducted: 0, totalPointsCost: 300, valuePaise: 30_000n }); // refunded
    addOrder(w, 'bajaj', { status: 'PENDING', pointsDeducted: 0, totalPointsCost: 200, valuePaise: null });
    addOrder(w, 'bajaj', { status: 'CONFIRMED', pointsDeducted: 700, totalPointsCost: 700, valuePaise: null }); // legacy
    const { rs, cap } = await exportAs(BAJAJ_ADMIN, w);
    const col = (h: string) => rs.rows.map((r) => r[rs.headers.indexOf(h)]);
    expect(col('Points deducted')).toEqual([500, 0, 0, 700]);
    expect(col('Points requested')).toEqual([500, 300, 200, 700]);
    expect(col('Value (₹)')).toEqual([500, 0, 0, 'Not recorded']);
    const total = cap.sheets.Summary.rows[0];
    const sumNum = (xs: XlsxCell[]) => xs.reduce<number>((s, x) => s + (typeof x === 'number' ? x : 0), 0);
    expect(total[3]).toBe(sumNum(col('Points deducted')));
    expect(total[4]).toBe(sumNum(col('Value (₹)')));
    expect(total[5]).toBe(sumNum(col('Points requested')));
    // Every section's groups add back up to the total.
    for (const section of ['By zone', 'By state', 'By status', 'By reward type', 'Delivery']) {
      const rows = cap.sheets.Summary.rows.filter((r) => r[0] === section);
      expect(sumNum(rows.map((r) => r[3]))).toBe(total[3]);
      expect(sumNum(rows.map((r) => r[2]))).toBe(total[2]);
    }
  });

  it('zone / state filter matches the PRIMARY outlet the row shows, not any outlet', async () => {
    const w = emptyWorld();
    const o = addOrder(w, 'bajaj', {}, { zone: 'East', state: 'Odisha' });
    (o.partner as { outlets: Row[] }).outlets.push({
      ...(o.partner as { outlets: Row[] }).outlets[0],
      id: 'ol-second',
      outletCode: 'OC-SECOND',
      zone: 'West',
      state: 'Goa',
      isPrimary: false,
      createdAt: at(-2000), // older, but not primary
    });
    // 0 matches → 404 (no file), reported here as [].
    const nos = async (raw: Row) =>
      exportAs(BAJAJ_ADMIN, w, raw).then(
        (r) => r.rs.rows.map((x) => x[0]),
        (e) => {
          if (e instanceof NotFoundException) return [];
          throw e;
        },
      );
    expect(await nos({ zone: 'west' })).toEqual([]);
    expect(await nos({ state: 'goa' })).toEqual([]);
    expect(await nos({ zone: 'EAST', state: 'odisha' })).toEqual([o.orderNumber]);
    const { cell } = await exportAs(BAJAJ_ADMIN, w, { zone: 'East' });
    expect(cell(o.orderNumber as string, 'Outlet code')).toBe('OC1');
  });

  it('hierarchy falls back to the member\'s other outlets (active, oldest first), then partner level', async () => {
    const w = emptyWorld();
    addChain(w, 'bajaj', 'F');
    addChain(w, 'bajaj', 'G');
    const o = addOrder(w, 'bajaj');
    const outlets = (o.partner as { outlets: Row[] }).outlets;
    outlets.push({ ...outlets[0], id: 'ol-inactive', isPrimary: false, isActive: false, createdAt: at(-3000) });
    outlets.push({ ...outlets[0], id: 'ol-active', isPrimary: false, isActive: true, createdAt: at(-500) });
    w.assignments.push({ id: 'a1', outletId: 'ol-inactive', partnerId: null, salesUserId: 'G-XSR', unassignedAt: null, assignedAt: at(0), salesUser: { clientId: 'bajaj' } });
    w.assignments.push({ id: 'a2', outletId: 'ol-active', partnerId: null, salesUserId: 'F-XSR', unassignedAt: null, assignedAt: at(0), salesUser: { clientId: 'bajaj' } });
    const { cell } = await exportAs(BAJAJ_ADMIN, w);
    expect(cell(o.orderNumber as string, 'ISR code')).toBe('XSR-F'); // the active other outlet wins over the older inactive one

    const w2 = emptyWorld();
    addChain(w2, 'bajaj', 'P');
    const o2 = addOrder(w2, 'bajaj');
    w2.assignments.push({ id: 'a3', outletId: null, partnerId: (o2.partner as Row).id, salesUserId: 'P-XSR', unassignedAt: null, assignedAt: at(0), salesUser: { clientId: 'bajaj' } });
    expect((await exportAs(BAJAJ_ADMIN, w2)).cell(o2.orderNumber as string, 'ISR code')).toBe('XSR-P');
  });

  it('a SUSPENDED post holder is shown as vacant; headers use the shared rung label (not a custom level name)', () => {
    const w = emptyWorld();
    addChain(w, 'deoleo', 'S');
    (w.salesUsers.find((s) => s.id === 'S-SO') as Row).user = { name: 'Suspended Sam', status: 'SUSPENDED' };
    const levels = (w.levels.filter((l) => l.clientId === 'deoleo') as unknown as LevelDef[]).map((l) =>
      l.code === 'ASM' ? { ...l, name: 'Area Sales Manager' } : l,
    );
    const ctx = { clientId: 'deoleo', levels, nodes: new Map((w.salesUsers as unknown as SalesNode[]).map((n) => [n.id, n])) };
    expect(hierarchyCells('S-XSR', ctx).slice(2, 4)).toEqual(['Vacant (SO-S)', 'SO-S']);
    expect(hierarchyHeaders(ctx).slice(4, 6)).toEqual(['ASM', 'ASM code']);
    // A non-standard level keeps the tenant's own name.
    expect(hierarchyHeaders({ clientId: 'deoleo', levels: [{ id: 'x', code: 'TSE', name: 'Territory Exec', level: 1 }] })).toEqual(['Territory Exec', 'Territory Exec code']);
  });

  it('payout: the PAID transaction wins over a newer failed attempt; a failed attempt never shows TDS', async () => {
    const w = emptyWorld();
    const paid = addOrder(w, 'bajaj', { redemptionMode: 'UPI', fulfilmentChannel: null });
    w.payouts.push({ id: 'x1', redemptionOrderId: paid.id, status: 'SUCCESS', completedAt: at(20), providerRefId: 'UTR1', tdsPaise: 500n, createdAt: at(10) });
    w.payouts.push({ id: 'x2', redemptionOrderId: paid.id, status: 'FAILED', completedAt: null, providerRefId: null, tdsPaise: 900n, createdAt: at(30) });
    const failed = addOrder(w, 'bajaj', { redemptionMode: 'BANK_TRANSFER', fulfilmentChannel: null, status: 'CONFIRMED' });
    w.payouts.push({ id: 'x3', redemptionOrderId: failed.id, status: 'FAILED', completedAt: null, providerRefId: null, tdsPaise: 900n, createdAt: at(30) });
    const { cell } = await exportAs(BAJAJ_ADMIN, w);
    expect(cell(paid.orderNumber as string, 'Payout status')).toBe('Paid');
    expect(cell(paid.orderNumber as string, 'TDS deducted (₹)')).toBe(5);
    expect(cell(paid.orderNumber as string, 'Bank reference (UTR)')).toBe('UTR1');
    expect(cell(failed.orderNumber as string, 'Payout status')).toBe('Failed');
    expect(cell(failed.orderNumber as string, 'TDS deducted (₹)')).toBe(0);
    expect(cell(failed.orderNumber as string, 'Paid on (IST)')).toBe('—');
  });

  it('days placed → delivered and the delivery average count only CURRENTLY delivered orders', async () => {
    const w = emptyWorld();
    const returned = addOrder(w, 'bajaj', { status: 'RETURNED', createdAt: at(0), deliveredAt: at(24), cancelledAt: at(48), pointsDeducted: 0 });
    hist(w, returned, [['DISPATCHED', 'DELIVERED', 24, 'u-op'], ['DELIVERED', 'RETURNED', 48, 'u-op']]);
    const delivered = addOrder(w, 'bajaj', { status: 'DELIVERED', createdAt: at(0), deliveredAt: at(72) });
    const { cell, cap } = await exportAs(BAJAJ_ADMIN, w);
    expect(cell(returned.orderNumber as string, 'Days placed → delivered')).toBe('Not delivered');
    expect(cell(delivered.orderNumber as string, 'Days placed → delivered')).toBe(3);
    const total = cap.sheets.Summary.rows[0];
    expect(total[6]).toBe(1);
    expect(total[7]).toBe(3);
  });

  it('an un-assumed owner\'s unknown ?clientId= is a 400 "Unknown client"', async () => {
    const w = emptyWorld();
    addOrder(w, 'bajaj');
    const params = REDEMPTION_REPORT_KIND.parseParams({ ...NOV, clientId: 'nope' }, GIFSY);
    const { prisma } = prismaFor(w);
    await expect(REDEMPTION_REPORT_KIND.run(ctxFor(GIFSY, prisma, []), params, captureWriter().w)).rejects.toThrow(/Unknown client: nope/);
  });

  it('cursor paging: 4,500 orders → every order exactly once, in order', async () => {
    const w = emptyWorld();
    for (let i = 0; i < 4500; i++) addOrder(w, 'bajaj');
    const { rs, calls } = await exportAs(BAJAJ_ADMIN, w);
    const nos = rs.rows.map((r) => r[0]);
    expect(new Set(nos).size).toBe(4500);
    expect(nos[0]).toBe('BAJAJ-25-1');
    expect(nos[4499]).toBe('BAJAJ-25-4500');
    expect(calls.filter((c) => c === 'redemptionOrder')).toHaveLength(3); // 2,000 + 2,000 + 500
  }, 60_000);
});
