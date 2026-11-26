/**
 * Off-portal payments register (owner-approved 2026-11-25) — end-to-end through an in-memory, where-aware Prisma fake:
 * upload preview → confirm (acks server-enforced) → the consumers (194R base, 194C report, fund line, payout history,
 * payments-report totals) → void. Dates are relative to "now" (never a hardcoded future date).
 */
import * as XLSX from 'xlsx';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OffPortalPaymentsService } from './off-portal-payments.service';
import { parseAmountCell, parseOffPortalFile } from './off-portal-payments.parse';
import { collect194RBases, liability194R, noPanOutletKey, noPanPartnerKey } from '../tds/tds-194r.shared';
import { DEFAULT_RESOLVED_TDS_STATUTORY, financialYear } from '../tds/tds.helpers';
import { TdsService } from '../tds/tds.service';
import { offPortalItem } from '../fund/fund-sources.loader';
import { buildFundStatement } from '../fund/fund-statement.engine';
import { buildPayoutStatement } from '../common/payout-statement.helper';
import { offPortalTotals, offPortalWhere } from '../payments-report/payments-report.query';
import { istDateKey } from '../common/ist-date';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = new Date();
const FY = financialYear(NOW);
/** An IST calendar day `days` into the current FY, as DD/MM/YYYY (never in the future: clamped to today). */
const fyDay = (days: number): string => {
  const d = new Date(Math.min(FY.start.getTime() + days * 86_400_000 + 6 * 3_600_000, NOW.getTime()));
  const k = istDateKey(d);
  return `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;
};
/** A day in the PREVIOUS FY. */
const prevFyDay = (): string => {
  const k = istDateKey(new Date(FY.start.getTime() - 10 * 86_400_000));
  return `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;
};

// ── generic where-matcher for the fake ──────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const eqCi = (a: unknown, b: unknown, ci: boolean) =>
  ci && typeof a === 'string' && typeof b === 'string' ? a.toUpperCase() === b.toUpperCase() : a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());
function fieldOk(v: any, f: any): boolean {
  if (f === undefined) return true;
  if (f === null) return v === null || v === undefined;
  if (!isObj(f)) return eqCi(v, f, false);
  const ci = f.mode === 'insensitive';
  if ('in' in f && !(f.in as any[]).some((x) => eqCi(v, x, ci))) return false;
  if ('equals' in f && !eqCi(v, f.equals, ci)) return false;
  if ('not' in f) {
    if (f.not === null) {
      if (v === null || v === undefined) return false;
    } else if (isObj(f.not)) {
      if (fieldOk(v, f.not)) return false;
    } else if (v === f.not) return false;
  }
  if ('gte' in f && !(v != null && v >= f.gte)) return false;
  if ('gt' in f && !(v != null && v > f.gt)) return false;
  if ('lt' in f && !(v != null && v < f.lt)) return false;
  if ('lte' in f && !(v != null && v <= f.lte)) return false;
  if ('contains' in f && !(typeof v === 'string' && (ci ? v.toUpperCase().includes(String(f.contains).toUpperCase()) : v.includes(f.contains)))) return false;
  return true;
}
function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, f] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(f as any[]).some((w) => matches(row, w))) return false;
    } else if (k === 'AND') {
      if (!(f as any[]).every((w) => matches(row, w))) return false;
    } else if (!fieldOk(row[k], f)) return false;
  }
  return true;
}
const pick = (row: any, select?: any) => {
  if (!select) return { ...row };
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
};

interface Store {
  outlets: Array<{ clientId: string; outletCode: string; name: string; partnerId: string | null; deletedAt?: Date | null }>;
  partners: Array<{ id: string; clientId: string; panNumber: string | null; businessName?: string | null; ownerName?: string | null; isParent?: boolean; entityType?: string | null }>;
  payments: any[];
  legacy: Array<{ id: string; clientId: string; section: string; panNumber: string; outletCode: string | null; amountPaise: bigint; entryDate: Date; resolvedKey?: string | null }>;
  uploads: any[];
  payees: any[];
  audits: any[];
  openings: Array<{ clientId: string; receivedAt: Date }>;
}
const newStore = (): Store => ({ outlets: [], partners: [], payments: [], legacy: [], uploads: [], payees: [], audits: [], openings: [] });

let idSeq = 0;
function fakeDb(s: Store): any {
  const partnerOf = (id: string | null) => s.partners.find((p) => p.id === id) ?? null;
  const models: Record<string, any> = {
    outlet: {
      findMany: async ({ where, select }: any) =>
        s.outlets
          .filter((o) => matches(o, where))
          .map((o) => {
            const out = pick(o, select);
            if (select?.partner) out.partner = partnerOf(o.partnerId) ? pick(partnerOf(o.partnerId), select.partner.select) : null;
            return out;
          }),
    },
    channelPartner: { findMany: async ({ where, select }: any) => s.partners.filter((p) => matches({ isParent: false, ...p }, where)).map((p) => pick(p, select)) },
    offPortalPayment: {
      findMany: async ({ where, select, skip, take }: any) => {
        const rows = s.payments.filter((p) => matches(p, where)).map((p) => pick(p, select));
        return take ? rows.slice(skip ?? 0, (skip ?? 0) + take) : rows;
      },
      findFirst: async ({ where, select }: any) => {
        const r = s.payments.find((p) => matches(p, where));
        return r ? pick(r, select) : null;
      },
      createMany: async ({ data }: any) => {
        for (const d of data) s.payments.push({ id: `op${++idSeq}`, voidedAt: null, voidedById: null, voidReason: null, createdAt: new Date(), supersedesOffPlatformEntryId: null, ...d });
        return { count: data.length };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = s.payments.filter((p) => matches(p, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
      count: async ({ where }: any) => s.payments.filter((p) => matches(p, where)).length,
      aggregate: async ({ where }: any) => {
        const rows = s.payments.filter((p) => matches(p, where));
        return { _count: { _all: rows.length }, _sum: { amountPaise: rows.length ? rows.reduce((a, r) => a + r.amountPaise, 0n) : null } };
      },
    },
    offPortalPaymentUpload: {
      create: async ({ data }: any) => {
        const u = { id: `up${++idSeq}`, createdAt: new Date(), ...data };
        s.uploads.push(u);
        return u;
      },
      findMany: async ({ where }: any) => s.uploads.filter((u) => matches(u, where)),
    },
    offPortalPayee: {
      findMany: async ({ where, select }: any) => s.payees.filter((p) => matches(p, where)).map((p) => pick(p, select)),
      createMany: async ({ data }: any) => {
        for (const d of data) s.payees.push({ id: `pe${++idSeq}`, ...d });
        return { count: data.length };
      },
      update: async ({ where, data }: any) => {
        const k = where.clientId_outletCodeKey;
        const p = s.payees.find((x) => x.clientId === k.clientId && x.outletCodeKey === k.outletCodeKey);
        Object.assign(p, data);
        return p;
      },
    },
    tdsOffPlatformEntry: { findMany: async ({ where, select }: any) => s.legacy.filter((l) => matches(l, where)).map((l) => pick(l, select)) },
    fundReceipt: { findFirst: async ({ where }: any) => s.openings.find((o) => o.clientId === where.clientId) ?? null },
    auditLog: { create: async ({ data }: any) => (s.audits.push(data), data) },
    user: { findMany: async () => [] },
    programSetting: { findUnique: async () => null },
    creditField: { findMany: async () => [] },
  };
  const db: any = new Proxy(models, {
    get(t, k: string) {
      if (k === '$transaction') return async (fn: any) => fn(db);
      if (k === '$executeRaw') return async () => 0;
      if (k === 'then') return undefined;
      if (!(k in t)) t[k] = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null, aggregate: async () => ({ _count: { _all: 0 }, _sum: {} }) };
      return t[k];
    },
  });
  return db;
}

const CLIENT = 'acme';
const OTHER = 'other';
const gifsy = (over: Partial<JwtPayload> = {}): JwtPayload => ({ sub: 'u-gifsy', role: 'GIFSY_ADMIN', clientId: CLIENT, phone: '', name: 'G', assumed: true, ...over });

const HEAD = ['Outlet ID', 'Outlet name', 'Phone', 'PAN', 'Bank account no.', 'IFSC', 'UPI ID', 'Amount (₹)', 'Payment date', 'UTR / reference', 'Payment type', 'Cash or Gift', 'Month', 'Narration'];
type Row = Partial<Record<'id' | 'name' | 'phone' | 'pan' | 'acc' | 'ifsc' | 'upi' | 'amount' | 'date' | 'utr' | 'type' | 'mode' | 'month' | 'narr', string | number>>;
const fileOf = (rows: Row[]): Express.Multer.File => {
  const aoa = [HEAD, ...rows.map((r) => [r.id ?? '', r.name ?? '', r.phone ?? '', r.pan ?? '', r.acc ?? '', r.ifsc ?? '', r.upi ?? '', r.amount ?? '', r.date ?? '', r.utr ?? '', r.type ?? 'Incentive', r.mode ?? 'Cash', r.month ?? '', r.narr ?? ''])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { buffer, originalname: 'op.xlsx', size: buffer.length } as Express.Multer.File;
};

function setup(policy: { section: 'SEC_194R' | 'SEC_194C'; methodology: 'DEDUCT' | 'GROSS_UP' } = { section: 'SEC_194C', methodology: 'GROSS_UP' }) {
  const s = newStore();
  s.partners.push(
    { id: 'p-pan', clientId: CLIENT, panNumber: 'ABCDE1234F', businessName: 'Sharma Stores', ownerName: 'R Sharma' },
    { id: 'p-nopan', clientId: CLIENT, panNumber: null, businessName: 'Gupta Traders', ownerName: 'S Gupta' },
    { id: 'p-other', clientId: OTHER, panNumber: 'ZZZZZ9999Z', businessName: 'Other Co' },
  );
  s.outlets.push(
    { clientId: CLIENT, outletCode: 'OUT1', name: 'Sharma Stores', partnerId: 'p-pan' },
    { clientId: CLIENT, outletCode: 'OUT2', name: 'Gupta Traders', partnerId: 'p-nopan' },
    { clientId: OTHER, outletCode: 'OUTX', name: 'Other Co', partnerId: 'p-other' },
  );
  const db = fakeDb(s);
  const storage = { generateKey: jest.fn((f: string, n: string) => `${f}/${n}`), uploadFile: jest.fn(async () => 'url'), deleteFile: jest.fn(async () => undefined) };
  const tenantSettings = { resolveTdsPolicy: jest.fn(async () => policy) };
  const svc = new OffPortalPaymentsService(db, storage as any, tenantSettings as any);
  return { s, db, svc, storage, tenantSettings };
}

async function previewAndConfirm(svc: OffPortalPaymentsService, file: Express.Multer.File, user = gifsy()) {
  const p = await svc.preview(user, file);
  return { preview: p, result: await svc.confirm(user, file, { fileSha256: p.fileSha256, acknowledged: p.requiredAcknowledgements }) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('parse — every bad row listed with ALL its errors (never dropped)', () => {
  it('cash needs a UTR, gift does not; bad PAN / future date / bad type are errors; month defaults to the payment month', () => {
    const future = istDateKey(new Date(NOW.getTime() + 5 * 86_400_000));
    const p = parseOffPortalFile(
      fileOf([
        { id: 'OUT1', name: 'Sharma', amount: 100, date: fyDay(10), utr: '' }, // cash, no UTR
        { id: 'OUT1', name: 'Sharma', amount: 100, date: fyDay(10), utr: '', mode: 'Gift' }, // ok
        { id: 'OUT1', name: 'Sharma', amount: 100, date: future, utr: 'U', pan: 'BAD' }, // future + bad PAN
        { id: 'OUT1', name: 'Sharma', amount: '1,250.50', date: fyDay(10), utr: 'U', type: 'Bonus' },
        { type: '', mode: '' }, // entirely blank → counted, not listed
      ]).buffer,
    );
    expect(p.fileError).toBeNull();
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ paymentMode: 'GIFT', utr: null, period: p.rows[0].paymentDay.slice(0, 7) });
    expect(p.blankRows).toBe(1);
    expect(p.invalid.map((r) => r.rowNumber)).toEqual([2, 4, 5]);
    expect(p.invalid[0].errors).toContain('UTR / reference is required for a cash payment');
    expect(p.invalid[1].errors.join(' ')).toMatch(/not a valid PAN/);
    expect(p.invalid[1].errors.join(' ')).toMatch(/in the future/);
    expect(p.invalid[2].errors.join(' ')).toMatch(/Incentive or Visibility/);
  });
  it('a missing required column rejects the whole file', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Outlet ID', 'Amount'], ['A', 1]]), 'S');
    const p = parseOffPortalFile(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(p.fileError).toMatch(/missing required column/);
  });
  it('amounts: paise exact, >2 decimals refused, ₹1 crore ceiling', () => {
    expect(parseAmountCell('₹1,234.5')).toEqual({ paise: 123450n });
    expect(parseAmountCell(0.1 + 0.2)).toEqual({ paise: 30n });
    expect(parseAmountCell('10.123')).toHaveProperty('error');
    expect(parseAmountCell(20_000_000)).toHaveProperty('error');
  });
});

describe('who may upload — Gifsy admin, assumed into the client, only', () => {
  it('refuses a client admin, a Gifsy staff member and an un-assumed Gifsy admin', async () => {
    const { svc } = setup();
    const f = fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'U1' }]);
    await expect(svc.preview(gifsy({ role: 'CLIENT_ADMIN', assumed: false }), f)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.preview(gifsy({ role: 'GIFSY_STAFF' }), f)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.preview(gifsy({ assumed: false }), f)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.void(gifsy({ role: 'CLIENT_ADMIN', assumed: false }), 'x', 'mistake made')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('preview → confirm', () => {
  it('matched outlet: blank file PAN → the portal PAN; differing file PAN → PAN_MISMATCH (counts under the file PAN); unmatched → off-portal payee; no PAN → NO_PAN', async () => {
    const { svc, s } = setup();
    const f = fileOf([
      { id: 'out1', name: 'Sharma Stores', amount: 1000, date: fyDay(5), utr: 'U1' }, // case-insensitive match, portal PAN
      { id: 'OUT1', name: 'Sharma Stores', amount: 2000, date: fyDay(6), utr: 'U2', pan: 'PQRST6789K' }, // mismatch
      { id: 'NEW9', name: 'Fresh Mart', amount: 3000, date: fyDay(7), utr: 'U3', phone: '9876543210' }, // not on portal, no PAN
      { id: 'OUT2', name: 'Gupta Traders', amount: 400, date: fyDay(8), mode: 'Gift' }, // owner has no PAN
    ]);
    const p = await svc.preview(gifsy(), f);
    const byRow = new Map(p.rows.map((r) => [r.rowNumber, r]));
    expect(byRow.get(2)).toMatchObject({ onPortal: true, panNumber: 'ABCDE1234F', panSource: 'PORTAL', flags: [] });
    expect(byRow.get(3)).toMatchObject({ panNumber: 'PQRST6789K', panSource: 'FILE', flags: ['PAN_MISMATCH'] });
    expect(byRow.get(4)!.flags).toEqual(['NEW_PAYEE', 'NO_PAN']);
    expect(byRow.get(5)!.flags).toEqual(['NO_PAN']);
    expect(p.requiredAcknowledgements).toEqual(['NEW_PAYEE', 'PAN_MISMATCH', 'NO_PAN']);

    // Server-enforced ticks: one missing → refused, nothing written, stored file removed.
    await expect(svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: ['NEW_PAYEE', 'NO_PAN'] })).rejects.toMatchObject({
      response: { missingAcknowledgements: ['PAN_MISMATCH'] },
    });
    expect(s.payments).toHaveLength(0);
    // A different file than the one previewed → refused.
    await expect(svc.confirm(gifsy(), fileOf([{ id: 'OUT1', name: 'x', amount: 1, date: fyDay(5), utr: 'U' }]), { fileSha256: p.fileSha256, acknowledged: p.requiredAcknowledgements })).rejects.toBeInstanceOf(BadRequestException);

    const r = await svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: p.requiredAcknowledgements.join(',') });
    expect(r).toMatchObject({ recorded: 4, skippedInvalid: 0, recordedTotalPaise: '640000' });
    expect(s.payments.map((x) => [x.outletCode, x.outletCodeKey, x.panNumber, x.tdsSection, x.onPortalAtUpload])).toEqual([
      ['OUT1', 'OUT1', 'ABCDE1234F', 'SEC_194R', true], // portal's spelling of the code is stored
      ['OUT1', 'OUT1', 'PQRST6789K', 'SEC_194R', true],
      ['NEW9', 'NEW9', null, 'SEC_194R', false],
      ['OUT2', 'OUT2', null, 'SEC_194R', true],
    ]);
    expect(s.payees).toEqual([expect.objectContaining({ clientId: CLIENT, outletCodeKey: 'NEW9', name: 'Fresh Mart', phone: '9876543210' })]);
    expect(s.uploads[0]).toMatchObject({ recordedCount: 4, fileKey: `off-portal-payments/${CLIENT}/op.xlsx` });
    // Audited — counts / amounts only, never PII.
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({ action: 'IMPORT', entityType: 'OFF_PORTAL_PAYMENT_UPLOAD' });
    expect(JSON.stringify(s.audits[0])).not.toMatch(/9876543210|ABCDE1234F|PQRST6789K/);
  });

  it('invalid rows must be acknowledged and are NOT recorded; the valid rest is', async () => {
    const { svc, s } = setup();
    const f = fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'U1' },
      { id: '', name: 'No id', amount: 100, date: fyDay(5), utr: 'U2' },
    ]);
    const p = await svc.preview(gifsy(), f);
    expect(p.categories).toEqual([expect.objectContaining({ category: 'INVALID', count: 1 })]);
    expect(p.invalid[0].errors).toContain('Outlet ID is required');
    await expect(svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: [] })).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: ['INVALID'] });
    expect(r).toMatchObject({ recorded: 1, skippedInvalid: 1 });
    expect(s.payments).toHaveLength(1);
  });

  it('duplicates (same outlet + amount + date + UTR): refused unless acknowledged; repeats inside one file too', async () => {
    const { svc, s } = setup();
    const f = fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'utr 1' }]);
    await previewAndConfirm(svc, f);
    const again = await svc.preview(gifsy(), fileOf([{ id: 'out1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'UTR1' }]));
    expect(again.requiredAcknowledgements).toEqual(['DUPLICATE']);
    expect(again.rows[0].notes[0]).toMatch(/already recorded/);
    const f2 = fileOf([{ id: 'out1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'UTR1' }]);
    await expect(svc.confirm(gifsy(), f2, { fileSha256: again.fileSha256, acknowledged: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(s.payments).toHaveLength(1);
    await svc.confirm(gifsy(), f2, { fileSha256: again.fileSha256, acknowledged: ['DUPLICATE'] });
    expect(s.payments).toHaveLength(2);

    const inFile = await svc.preview(gifsy(), fileOf([
      { id: 'OUT2', name: 'Gupta Traders', amount: 5, date: fyDay(9), utr: 'Z', pan: 'AAAAA1111A' },
      { id: 'OUT2', name: 'Gupta Traders', amount: 5, date: fyDay(9), utr: 'Z', pan: 'AAAAA1111A' },
    ]));
    expect(inFile.rows[1].flags).toEqual(['DUPLICATE']);
    expect(inFile.rows[1].notes[0]).toMatch(/Repeats row 2/);
  });

  it('tenant isolation: another client\'s outlet code never matches; name mismatch is flagged', async () => {
    const { svc } = setup();
    const p = await svc.preview(gifsy(), fileOf([
      { id: 'OUTX', name: 'Other Co', amount: 100, date: fyDay(5), utr: 'U' },
      { id: 'OUT1', name: 'Completely Different', amount: 100, date: fyDay(5), utr: 'V', pan: 'ABCDE1234F' },
    ]));
    expect(p.rows[0]).toMatchObject({ onPortal: false, flags: expect.arrayContaining(['NEW_PAYEE']) });
    expect(p.rows[1].flags).toEqual(['NAME_DIFFERS']);
  });

  it('visibility on the Deduct method → TDS_NOT_WITHHELD; dated before the fund opening → BEFORE_FUND_OPENING', async () => {
    const { svc, s } = setup({ section: 'SEC_194R', methodology: 'DEDUCT' });
    s.openings.push({ clientId: CLIENT, receivedAt: new Date(NOW.getTime() - 86_400_000) });
    const p = await svc.preview(gifsy(), fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: prevFyDay(), utr: 'U', type: 'Visibility' }]));
    expect(p.rows[0].flags).toEqual(['BEFORE_FUND_OPENING', 'TDS_NOT_WITHHELD']);
    expect(p.rows[0].tdsSection).toBe('194R');
  });
});

describe('void', () => {
  it('voids with a reason (audited), never twice, and never another client\'s entry', async () => {
    const { svc, s } = setup();
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'U1' }]));
    const id = s.payments[0].id;
    await expect(svc.void(gifsy(), id, 'no')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.void(gifsy({ clientId: OTHER }), id, 'wrong client')).rejects.toBeInstanceOf(NotFoundException);
    const r = await svc.void(gifsy(), id, 'uploaded twice by mistake');
    expect(r.voidedAt).toBeTruthy();
    expect(s.payments[0]).toMatchObject({ voidReason: 'uploaded twice by mistake', voidedById: 'u-gifsy' });
    expect(s.audits.at(-1)).toMatchObject({ entityType: 'OFF_PORTAL_PAYMENT', entityId: id, metadata: { action: 'off_portal_payment_void' } });
    await expect(svc.void(gifsy(), id, 'again please')).rejects.toBeInstanceOf(ConflictException);
  });

  it('list: client admin sees its own register with PII masked; Gifsy admin unmasked; another client sees nothing', async () => {
    const { svc } = setup();
    await previewAndConfirm(svc, fileOf([{ id: 'NEW9', name: 'Fresh Mart', amount: 100, date: fyDay(5), utr: 'U1', phone: '9876543210', pan: 'ABCDE1234F', acc: '123456789012', ifsc: 'HDFC0001234' }]));
    const asClient = await svc.list(gifsy({ role: 'CLIENT_ADMIN', assumed: false }), {});
    expect(asClient.rows[0]).toMatchObject({ phone: '••••••3210', panNumber: 'AB•••••34F', bankAccountNumber: '••••••9012', onPortalNow: false });
    expect(asClient.canWrite).toBe(false);
    const asGifsy = await svc.list(gifsy(), {});
    expect(asGifsy.rows[0]).toMatchObject({ phone: '9876543210', panNumber: 'ABCDE1234F', bankAccountNumber: '123456789012' });
    const other = await svc.list(gifsy({ role: 'CLIENT_ADMIN', clientId: OTHER, assumed: false }), {});
    expect(other.totalRows).toBe(0);
  });
});

describe('consumers', () => {
  async function recorded(policy?: { section: 'SEC_194R' | 'SEC_194C'; methodology: 'DEDUCT' | 'GROSS_UP' }) {
    const ctx = setup(policy);
    await previewAndConfirm(
      ctx.svc,
      fileOf([
        { id: 'OUT1', name: 'Sharma Stores', amount: 10_000, date: fyDay(5), utr: 'C1' }, // incentive cash → cash
        { id: 'OUT1', name: 'Sharma Stores', amount: 4_000, date: fyDay(6), mode: 'Gift' }, // gift → non-cash
        { id: 'OUT1', name: 'Sharma Stores', amount: 7_000, date: fyDay(7), utr: 'V1', type: 'Visibility' }, // vis cash
        { id: 'OUT1', name: 'Sharma Stores', amount: 999, date: prevFyDay(), utr: 'OLD' }, // previous FY
        { id: 'OUT2', name: 'Gupta Traders', amount: 3_000, date: fyDay(8), utr: 'N1' }, // no PAN → owner's no-PAN key
        { id: 'NEW9', name: 'Fresh Mart', amount: 2_000, date: fyDay(9), utr: 'N2' }, // not on portal → per-outlet key
      ]),
    );
    return ctx;
  }

  it('194R base: FY by payment date, cash vs gift vs visibility buckets, PAN / no-PAN keys, voided ignored', async () => {
    const { db, s } = await recorded({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    const bases = await collect194RBases(db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(bases.get('ABCDE1234F')).toMatchObject({ hasPan: true, cashPaise: 1_000_000n, nonCashPaise: 400_000n, visPaise: 700_000n });
    expect(bases.get(noPanPartnerKey('p-nopan'))).toMatchObject({ hasPan: false, cashPaise: 300_000n });
    expect(bases.get(noPanOutletKey(CLIENT, 'NEW9'))).toMatchObject({ hasPan: false, cashPaise: 200_000n });
    // No-PAN → the no-PAN rate (20%) on the whole year once over the threshold.
    const l = liability194R({ hasPan: false, visPaise: 0n, cashPaise: 3_000_000n, nonCashPaise: 0n }, 'GROSS_UP', DEFAULT_RESOLVED_TDS_STATUTORY);
    expect(l.ratePct).toBe(20);
    // Previous-FY payment is in the previous FY only.
    const prevFy = financialYear(new Date(FY.start.getTime() - 86_400_000)).fyLabel;
    const prev = await collect194RBases(db, { clientId: CLIENT, fyLabel: prevFy, importedCountFrom: null });
    expect(prev.get('ABCDE1234F')).toMatchObject({ cashPaise: 99_900n });
    // Tenant isolation: another client's base is empty.
    expect((await collect194RBases(db, { clientId: OTHER, fyLabel: FY.fyLabel, importedCountFrom: null })).size).toBe(0);
    // Void reverses the TDS effect.
    s.payments.filter((p) => p.outletCodeKey === 'NEW9').forEach((p) => (p.voidedAt = new Date()));
    expect((await collect194RBases(db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null })).has(noPanOutletKey(CLIENT, 'NEW9'))).toBe(false);
  });

  it('an Outlet ID that registers LATER links its no-PAN history to the new owner automatically', async () => {
    const { db, s } = await recorded({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    s.partners.push({ id: 'p-new', clientId: CLIENT, panNumber: null });
    s.outlets.push({ clientId: CLIENT, outletCode: 'New9', name: 'Fresh Mart', partnerId: 'p-new' });
    const bases = await collect194RBases(db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(bases.get(noPanPartnerKey('p-new'))).toMatchObject({ cashPaise: 200_000n });
    const hist = await buildPayoutStatement(db, CLIENT, 'p-new');
    expect(hist).toEqual([expect.objectContaining({ offPortal: true, payoutAmountPaise: 200_000, status: 'PAID', utr: 'N2' })]);
  });

  it('no double count with a legacy TDS off-platform row: the matching payment REPLACES it (until voided)', async () => {
    const ctx = setup({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    const day = fyDay(5);
    const p0 = parseOffPortalFile(fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 5_000, date: day, utr: 'L1' }]).buffer).rows[0];
    ctx.s.legacy.push({ id: 'leg1', clientId: CLIENT, section: 'SEC_194R', panNumber: 'ABCDE1234F', outletCode: 'OUT1', amountPaise: 500_000n, entryDate: new Date(`${p0.paymentDay}T00:00:00Z`) });
    const before = await collect194RBases(ctx.db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(before.get('ABCDE1234F')).toMatchObject({ nonCashPaise: 500_000n, cashPaise: 0n });
    const { preview } = await previewAndConfirm(ctx.svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 5_000, date: day, utr: 'L1' }]));
    expect(preview.requiredAcknowledgements).toEqual(['REPLACES_TDS_ENTRY']);
    const after = await collect194RBases(ctx.db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(after.get('ABCDE1234F')).toMatchObject({ nonCashPaise: 0n, cashPaise: 500_000n }); // once, as cash
    await ctx.svc.void(gifsy(), ctx.s.payments[0].id, 'entered in error');
    const voided = await collect194RBases(ctx.db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(voided.get('ABCDE1234F')).toMatchObject({ nonCashPaise: 500_000n, cashPaise: 0n }); // the legacy row counts again
  });

  it('194R report: off-portal amount said on the row; Deduct visibility → TDS NOT WITHHELD shortfall', async () => {
    const { db } = await recorded({ section: 'SEC_194R', methodology: 'DEDUCT' });
    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, { resolveTdsPolicy: async () => ({ section: 'SEC_194R', methodology: 'DEDUCT' }) } as any);
    const { rows, summary } = await tds.report194R(CLIENT, FY.fyLabel);
    const row = rows.find((r) => r.panNumber === 'ABCDE1234F')!;
    expect(row).toMatchObject({ offPortalPaidPaise: 2_100_000n, offPortalNotWithheldPaise: 700_000n });
    expect(row.note).toMatch(/TDS NOT WITHHELD — SHORTFALL/);
    expect(summary).toMatchObject({ totalOffPortalNotWithheldPaise: 700_000n, offPortalNotWithheldRetailerCount: 1 });
  });

  it('194C report: a visibility payment under a 194C policy counts in 194C (not 194R), Deduct → shortfall note', async () => {
    const { db } = await recorded({ section: 'SEC_194C', methodology: 'DEDUCT' });
    const r194 = await collect194RBases(db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(r194.get('ABCDE1234F')!.visPaise).toBe(0n);
    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, {} as any);
    const rows = await tds.compute194C(FY.fyLabel);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ panNumber: 'ABCDE1234F', baseFyTotalPaise: 700_000n, offPortalNotWithheldPaise: 700_000n, methodology: 'DEDUCT' });
    expect(rows[0].note).toMatch(/TDS NOT WITHHELD/);
  });

  it('Fund Reconciliation: a paid "Off-portal payment" line at the payment date, charged face + agency fee; void → returned', () => {
    const paidOn = new Date(FY.start.getTime() + 5 * 86_400_000);
    const item = offPortalItem({ id: 'x', outletCode: 'OUT1', outletName: 'Sharma', amountPaise: 100_000n, paymentDate: paidOn, utr: 'U', payoutStream: 'INCENTIVE', paymentMode: 'CASH', period: '2026-04', voidedAt: null });
    expect(item).toMatchObject({ type: 'OFF_PORTAL_PAYMENT', status: 'PAID', committedAt: paidOn, paidAt: paidOn });
    const rates = [{ kind: 'AGENCY_FEE' as const, feeType: 'PERCENT' as const, rateBps: 500, effectiveFrom: new Date(0), createdAt: new Date(0) }];
    const st = buildFundStatement({ items: [item], entries: [], rates });
    expect(st.lines[0]).toMatchObject({ type: 'OFF_PORTAL_PAYMENT', feePaise: 5_000n, chargedPaise: 105_000n, status: 'PAID' });
    const noFee = buildFundStatement({ items: [item], entries: [], rates: [] });
    expect(noFee.lines[0].flags).toContain('NO_FEE_RATE');
    const voided = offPortalItem({ ...{ id: 'x', outletCode: 'OUT1', outletName: 'Sharma', amountPaise: 100_000n, paymentDate: paidOn, utr: 'U', payoutStream: 'INCENTIVE', paymentMode: 'CASH', period: '2026-04' }, voidedAt: new Date(paidOn.getTime() + 86_400_000) });
    const st2 = buildFundStatement({ items: [voided], entries: [], rates });
    expect(st2.totals.paidPaise + st2.totals.committedPaise).toBe(0n);
    expect(st2.lines.map((l) => l.event)).toEqual(['CHARGE', 'RETURN']);
  });

  it('payout history (partner app + admin ledger) and payments-report totals include live entries only', async () => {
    const { db, s } = await recorded();
    const hist = await buildPayoutStatement(db, CLIENT, 'p-pan');
    expect(hist.filter((h) => h.offPortal)).toHaveLength(4);
    expect(hist.find((h) => h.gift)).toMatchObject({ kpiLabel: 'Off-portal incentive payment (gift)' });
    const tot = await offPortalTotals(db, offPortalWhere({ clientId: CLIENT }));
    expect(tot).toEqual({ count: 6, amountPaise: 2_699_900n });
    s.payments[0].voidedAt = new Date();
    expect((await buildPayoutStatement(db, CLIENT, 'p-pan')).filter((h) => h.offPortal)).toHaveLength(3);
    expect(offPortalWhere({ clientId: CLIENT, status: 'FAILED' as any })).toBeNull();
  });
});
