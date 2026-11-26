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
import { offPortalItem, tdsItems } from '../fund/fund-sources.loader';
import { buildFundStatement } from '../fund/fund-statement.engine';
import { buildPayoutStatement } from '../common/payout-statement.helper';
import { offPortalTotals, offPortalWhere } from '../payments-report/payments-report.query';
import { istDateKey } from '../common/ist-date';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreditsService } from '../credits/credits.service';
import { invalidateOffPortalPresence } from './off-portal-presence';

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
  recoveries: any[];
  invoices: any[];
  portalEntries: any[];
}
const newStore = (): Store => ({ outlets: [], partners: [], payments: [], legacy: [], uploads: [], payees: [], audits: [], openings: [], recoveries: [], invoices: [], portalEntries: [] });

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
    tdsRecoveryEntry: {
      findMany: async ({ where, select }: any) => s.recoveries.filter((r) => matches(r, where)).map((r) => pick(r, select)),
      findFirst: async ({ where }: any) => s.recoveries.find((r) => matches(r, where)) ?? null,
      createMany: async ({ data }: any) => {
        for (const d of data) s.recoveries.push({ id: `rec${++idSeq}`, createdAt: new Date(), ...d });
        return { count: data.length };
      },
    },
    // Portal payout entries (PAID / PROCESSING) for the engine's prior base + the PAID_ON_PORTAL check.
    creditPayoutEntry: {
      findMany: async ({ where, select }: any) =>
        s.portalEntries
          .filter((e) => matches(e, where))
          .map((e) => ({ ...pick(e, select), ...(select?.download ? { download: e.download ?? null } : {}) })),
    },
  };
  const db: any = new Proxy(models, {
    get(t, k: string) {
      if (k === '$transaction') return async (fn: any) => fn(db);
      if (k === '$executeRaw') return async () => 0;
      // scope194R: SELECT id, panNumber FROM channel_partners WHERE clientId = $1 AND normalised PAN = ANY($2)
      if (k === '$queryRaw') return async (q: any) => s.partners.filter((p) => p.clientId === q.values[0] && p.panNumber && q.values[1].includes(p.panNumber)).map((p) => ({ id: p.id, panNumber: p.panNumber }));
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
  // A fund opening long ago (so the default rows carry no fund warning; the no-opening case is tested on its own).
  s.openings.push({ clientId: CLIENT, receivedAt: new Date(Date.UTC(2015, 0, 1)) });
  const db = fakeDb(s);
  const storage = { generateKey: jest.fn((f: string, n: string) => `${f}/${n}`), uploadFile: jest.fn(async () => 'url'), deleteFile: jest.fn(async () => undefined) };
  const tenantSettings = { resolveTdsPolicy: jest.fn(async () => policy) };
  const invoices = {
    createTdsInvoice: jest.fn(async (_tx: unknown, p: any) => {
      const id = `inv${++idSeq}`;
      s.invoices.push({ id, ...p });
      return { invoiceId: id, gstPaise: 0n, gstApplicable: false };
    }),
  };
  const statutory = { getForFy: jest.fn(async () => DEFAULT_RESOLVED_TDS_STATUTORY) };
  const credits = new CreditsService(db, {} as any, {} as any, {} as any, tenantSettings as any, invoices as any, statutory as any);
  const svc = new OffPortalPaymentsService(db, storage as any, tenantSettings as any);
  return { s, db, svc, storage, tenantSettings, credits, invoices };
}
beforeEach(() => invalidateOffPortalPresence());

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
    // Keys (audit A1): the SAME resolution as portal payouts of the outlet — PAN, else the owner's / outlet's no-PAN key.
    expect(byRow.get(2)).toMatchObject({ onPortal: true, panNumber: 'ABCDE1234F', panSource: 'PORTAL', tdsKey: 'ABCDE1234F', flags: ['PORTAL_PAN_USED'] });
    expect(byRow.get(3)).toMatchObject({ panNumber: 'PQRST6789K', panSource: 'FILE', tdsKey: 'PQRST6789K', flags: ['PAN_MISMATCH'] });
    expect(byRow.get(4)).toMatchObject({ tdsKey: noPanOutletKey(CLIENT, 'NEW9'), flags: ['NEW_PAYEE', 'NO_PAN'] });
    expect(byRow.get(5)).toMatchObject({ tdsKey: noPanPartnerKey('p-nopan'), flags: ['NO_PAN', 'GIFT_NO_AGENCY_FEE'] });
    expect(byRow.get(5)!.tdsTreatment).toMatch(/borne by the client/);
    expect(p.requiredAcknowledgements).toEqual(['NEW_PAYEE', 'PAN_MISMATCH', 'NO_PAN', 'PORTAL_PAN_USED', 'GIFT_NO_AGENCY_FEE']);

    // Server-enforced ticks: one missing → refused (listed in `details` for the screen), nothing written.
    await expect(
      svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: ['NEW_PAYEE', 'NO_PAN', 'PORTAL_PAN_USED', 'GIFT_NO_AGENCY_FEE'] }),
    ).rejects.toMatchObject({
      response: { missingAcknowledgements: ['PAN_MISMATCH'], details: { missingAcknowledgements: ['PAN_MISMATCH'] } },
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
    expect(p.categories).toEqual([expect.objectContaining({ category: 'INVALID', count: 1 }), expect.objectContaining({ category: 'PORTAL_PAN_USED' })]);
    expect(p.invalid[0].errors).toContain('Outlet ID is required');
    await expect(svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: ['PORTAL_PAN_USED'] })).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: ['INVALID', 'PORTAL_PAN_USED'] });
    expect(r).toMatchObject({ recorded: 1, skippedInvalid: 1 });
    expect(s.payments).toHaveLength(1);
  });

  it('duplicates (same outlet + amount + date + UTR): refused unless acknowledged; repeats inside one file too', async () => {
    const { svc, s } = setup();
    const f = fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'utr 1' }]);
    await previewAndConfirm(svc, f);
    const again = await svc.preview(gifsy(), fileOf([{ id: 'out1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'UTR1' }]));
    expect(again.requiredAcknowledgements).toEqual(['PORTAL_PAN_USED', 'DUPLICATE']);
    expect(again.rows[0].notes.join(' ')).toMatch(/already recorded/);
    const f2 = fileOf([{ id: 'out1', name: 'Sharma Stores', amount: 100, date: fyDay(5), utr: 'UTR1' }]);
    await expect(svc.confirm(gifsy(), f2, { fileSha256: again.fileSha256, acknowledged: ['PORTAL_PAN_USED'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(s.payments).toHaveLength(1);
    await svc.confirm(gifsy(), f2, { fileSha256: again.fileSha256, acknowledged: ['PORTAL_PAN_USED', 'DUPLICATE'] });
    expect(s.payments).toHaveLength(2);

    const inFile = await svc.preview(gifsy(), fileOf([
      { id: 'OUT2', name: 'Gupta Traders', amount: 5, date: fyDay(9), utr: 'Z', pan: 'AAAAA1111A' },
      { id: 'OUT2', name: 'Gupta Traders', amount: 5, date: fyDay(9), utr: 'Z', pan: 'AAAAA1111A' },
    ]));
    expect(inFile.rows[1].flags).toEqual(['FILE_PAN_ONLY', 'DUPLICATE']);
    expect(inFile.rows[1].notes.join(' ')).toMatch(/Repeats row 2/);
    // FILE_PAN_ONLY (audit A4): the file has a PAN, the portal owner has none — says which key it counts under.
    expect(inFile.rows[0].notes.join(' ')).toMatch(/file PAN AAAAA1111A; the outlet's portal payouts count under its no-PAN key/);
  });

  it('possible duplicate (B4): same outlet + amount within ±3 days with a different UTR', async () => {
    const { svc } = setup();
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 700, date: fyDay(20), utr: 'A1' }]));
    const p = await svc.preview(gifsy(), fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 700, date: fyDay(22), utr: 'B2' }, // 2 days later, other UTR
      { id: 'OUT1', name: 'Sharma Stores', amount: 700, date: fyDay(40), utr: 'C3' }, // far away → not flagged
    ]));
    expect(p.rows[0].flags).toContain('POSSIBLE_DUPLICATE');
    expect(p.rows[1].flags).not.toContain('POSSIBLE_DUPLICATE');
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

  it('a payment already PAID through the portal (same outlet + UTR, or amount + day) → PAID_ON_PORTAL', async () => {
    const { svc, db } = setup();
    const day = parseOffPortalFile(fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 1, date: fyDay(5), utr: 'X' }]).buffer).rows[0].paymentDate;
    const portal = [
      { clientId: CLIENT, status: 'PAID', outletId: 'out1', amountPaise: 250_000n, paidAt: new Date(day.getTime() + 3_600_000), utr: 'BANK77', download: null },
      // In a bank file (PROCESSING, no paidAt yet) two days later — B4 / A5: counts too, ±3 days, UTR irrelevant.
      { clientId: CLIENT, status: 'PROCESSING', outletId: 'OUT1', amountPaise: 41_100n, paidAt: null, utr: null, download: { downloadedAt: new Date(day.getTime() + 2 * 86_400_000) } },
    ];
    db.creditPayoutEntry = {
      findMany: async ({ where }: any) =>
        portal
          .filter((e) =>
            matches({ clientId: e.clientId, outletId: e.outletId }, { clientId: where.clientId, outletId: where.outletId }) &&
            (where.OR ?? []).some((c: any) => c.status === e.status && (c.paidAt ? fieldOk(e.paidAt, c.paidAt) : !!e.download && fieldOk(e.download.downloadedAt, c.download.downloadedAt))),
          )
          .map((e) => ({ outletId: e.outletId, amountPaise: e.amountPaise, paidAt: e.paidAt, utr: e.utr, status: e.status, download: e.download })),
    };
    const p = await svc.preview(gifsy(), fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 999, date: fyDay(5), utr: 'bank 77' }, // same UTR
      { id: 'OUT1', name: 'Sharma Stores', amount: 2500, date: fyDay(5), utr: 'OTHER' }, // same amount + day
      { id: 'OUT1', name: 'Sharma Stores', amount: 411, date: fyDay(5), utr: 'OTHER2', pan: 'ABCDE1234F' }, // PROCESSING ±3 days
      { id: 'OUT1', name: 'Sharma Stores', amount: 12, date: fyDay(5), utr: 'NOPE' }, // nothing matches
    ]));
    expect(p.rows.map((r) => r.flags.includes('PAID_ON_PORTAL'))).toEqual([true, true, true, false]);
    expect(p.requiredAcknowledgements).toContain('PAID_ON_PORTAL');
  });

  it('owner 2026-11-26: a portal payout still PENDING / FAILED for the same outlet + amount (same month or ±3 days) → PORTAL_UNPAID, ticked + listed', async () => {
    const { svc, s } = setup();
    const row0 = parseOffPortalFile(fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 1, date: fyDay(5), utr: 'X' }]).buffer).rows[0];
    s.portalEntries.push(
      // PENDING for the same month (the next bank file would pay it).
      { clientId: CLIENT, status: 'PENDING', outletId: 'out1', amountPaise: 250_000n, period: row0.period, createdAt: new Date(row0.paymentDate.getTime() - 40 * 86_400_000), attemptedAt: null },
      // FAILED, awaiting re-bank, attempted 2 days after the payment date (another month).
      { clientId: CLIENT, status: 'FAILED', outletId: 'OUT1', amountPaise: 41_100n, period: '2000-01', createdAt: new Date(0), attemptedAt: new Date(row0.paymentDate.getTime() + 2 * 86_400_000) },
      // Already PAID — not "unpaid".
      { clientId: CLIENT, status: 'PAID', outletId: 'OUT1', amountPaise: 1_200n, period: row0.period, createdAt: new Date(), attemptedAt: null, paidAt: new Date(0), utr: 'U' },
    );
    const p = await svc.preview(gifsy(), fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 2500, date: fyDay(5), utr: 'A1' },
      { id: 'OUT1', name: 'Sharma Stores', amount: 411, date: fyDay(5), utr: 'A2' },
      { id: 'OUT1', name: 'Sharma Stores', amount: 12, date: fyDay(5), utr: 'A3' },
    ]));
    expect(p.rows.map((r) => r.flags.includes('PORTAL_UNPAID'))).toEqual([true, true, false]);
    expect(p.rows[0].notes.join(' ')).toMatch(/still PENDING — the next bank file pays it: cancel it or it will be paid again/);
    expect(p.rows[1].notes.join(' ')).toMatch(/still FAILED — it will be re-banked/);
    expect(p.requiredAcknowledgements).toContain('PORTAL_UNPAID');
    // Server-enforced: confirming without ticking it records nothing.
    const f = fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 2500, date: fyDay(5), utr: 'A1' }]);
    const p1 = await svc.preview(gifsy(), f);
    await expect(svc.confirm(gifsy(), f, { fileSha256: p1.fileSha256, acknowledged: p1.requiredAcknowledgements.filter((c: string) => c !== 'PORTAL_UNPAID') })).rejects.toThrow(/Portal payout still unpaid/);
    expect(s.payments).toHaveLength(0);
  });

  it('a legacy TDS entry under a DIFFERENT payee is never silently replaced (flagged, both count)', async () => {
    const { svc, s, db } = setup({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    const p0 = parseOffPortalFile(fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 5_000, date: fyDay(5), utr: 'L1' }]).buffer).rows[0];
    s.legacy.push({ id: 'leg2', clientId: CLIENT, section: 'SEC_194R', panNumber: 'KLMNO5555P', outletCode: 'OUT1', amountPaise: 500_000n, entryDate: new Date(`${p0.paymentDay}T00:00:00Z`) });
    const f = fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 5_000, date: fyDay(5), utr: 'L1' }]);
    const { preview } = await previewAndConfirm(svc, f);
    expect(preview.requiredAcknowledgements).toEqual(['PORTAL_PAN_USED', 'TDS_ENTRY_OTHER_PAYEE']);
    expect(s.payments[0].supersedesOffPlatformEntryId).toBeNull();
    const bases = await collect194RBases(db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(bases.get('KLMNO5555P')).toMatchObject({ nonCashPaise: 500_000n });
    expect(bases.get('ABCDE1234F')).toMatchObject({ cashPaise: 500_000n });
  });

  it('Deduct client → TDS_NOT_WITHHELD on EVERY row (A3); incentive rows show the client-borne method (B5); fund opening notices (A8)', async () => {
    const { svc, s } = setup({ section: 'SEC_194R', methodology: 'DEDUCT' });
    s.openings.splice(0, 1, { clientId: CLIENT, receivedAt: new Date(NOW.getTime() - 86_400_000) });
    const p = await svc.preview(gifsy(), fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 100, date: prevFyDay(), utr: 'U', type: 'Visibility' },
      { id: 'OUT1', name: 'Sharma Stores', amount: 100, date: prevFyDay(), utr: 'W', type: 'Incentive' },
    ]));
    expect(p.rows[0].flags).toEqual(['PORTAL_PAN_USED', 'BEFORE_FUND_OPENING', 'TDS_NOT_WITHHELD']);
    expect(p.rows[0]).toMatchObject({ tdsSection: '194R', tdsMethodology: 'DEDUCT' });
    expect(p.rows[0].tdsTreatment).toMatch(/never withheld from later payouts/);
    expect(p.rows[1]).toMatchObject({ tdsMethodology: 'GROSS_UP', flags: expect.arrayContaining(['TDS_NOT_WITHHELD']) });
    expect(p.rows[1].tdsTreatment).toMatch(/borne by the client/);
    // No opening at all → a loud notice on every row: everything is charged from the advance.
    s.openings.splice(0, 1);
    const q = await svc.preview(gifsy(), fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(3), utr: 'U' }]));
    expect(q.requiredAcknowledgements).toContain('NO_FUND_OPENING');
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
    expect(preview.requiredAcknowledgements).toEqual(['PORTAL_PAN_USED', 'REPLACES_TDS_ENTRY']);
    const after = await collect194RBases(ctx.db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(after.get('ABCDE1234F')).toMatchObject({ nonCashPaise: 0n, cashPaise: 500_000n }); // once, as cash
    await ctx.svc.void(gifsy(), ctx.s.payments[0].id, 'entered in error');
    const voided = await collect194RBases(ctx.db, { clientId: CLIENT, fyLabel: FY.fyLabel, importedCountFrom: null });
    expect(voided.get('ABCDE1234F')).toMatchObject({ nonCashPaise: 500_000n, cashPaise: 0n }); // the legacy row counts again
  });

  it('the reverse order is guarded too: a legacy off-platform upload of an already-recorded payment is refused per row', async () => {
    const ctx = await recorded({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    const day = ctx.s.payments.find((p) => p.utr === 'C1')!.paymentDate as Date;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'PAN', 'Outlet Code', 'Amount (₹)'], [istDateKey(day), 'ABCDE1234F', 'OUT1', 10_000], [istDateKey(day), 'ABCDE1234F', 'OUT1', 123]]), 'S');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const tds = new TdsService(ctx.db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, {} as any);
    const res = await tds.uploadOffPlatform(CLIENT, 'u', { buffer } as Express.Multer.File, false);
    expect(res.succeeded).toBe(1);
    expect(res.errors.map((e) => e.message).join(' ')).toMatch(/already recorded in the off-portal payments register/);
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
    const { db, s } = await recorded({ section: 'SEC_194R', methodology: 'GROSS_UP' });
    const hist = await buildPayoutStatement(db, CLIENT, 'p-pan');
    expect(hist.filter((h) => h.offPortal)).toHaveLength(4);
    expect(hist.find((h) => h.gift)).toMatchObject({ kpiLabel: 'Gift (off-portal) — incentive' });
    const tot = await offPortalTotals(db, offPortalWhere({ clientId: CLIENT }));
    expect(tot).toEqual({ count: 6, amountPaise: 2_699_900n });
    s.payments[0].voidedAt = new Date();
    expect((await buildPayoutStatement(db, CLIENT, 'p-pan')).filter((h) => h.offPortal)).toHaveLength(3);
    expect(offPortalWhere({ clientId: CLIENT, status: 'FAILED' as any })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Owner decisions 2026-11-26: off-portal payments COUNT toward the yearly TDS threshold (194R + 194C) but NEVER drive
// automatic catch-up withholding on later portal payouts; 194C gross-up TDS is invoiced to the client when recorded.

const taxInfo = (pan: string | null) => ({
  partnerId: 'p-pan', panNumber: pan, entityType: null, gstNumber: null, gstRegistrationType: null, businessName: 'Sharma Stores',
  ownerName: 'R Sharma', phone: null, bankName: null, accountNumber: null, ifscCode: null, outletName: 'Sharma Stores', retailerState: null,
});
const thisPeriod = () => istDateKey(NOW).slice(0, 7);

describe('owner 2026-11-26 — threshold yes, catch-up withholding never', () => {
  it('194R Deduct: an off-portal ₹30,000 visibility payment crosses the threshold; the next portal payout withholds ONLY its own TDS; the report shows the shortfall', async () => {
    const { svc, credits, db } = setup({ section: 'SEC_194R', methodology: 'DEDUCT' });
    const plan0 = await (credits as any).buildPayoutTdsPlan(db, {
      clientId: CLIENT, period: thisPeriod(), outletTaxMap: new Map([['OUT1', taxInfo('ABCDE1234F')]]), runAt: NOW,
      currentMethodology: 'DEDUCT', importedCountFrom: null,
      engineEntries: [{ id: 'e1', outletId: 'OUT1', amountPaise: 500_000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' }],
    });
    expect(plan0.deductionByOutlet.get('OUT1') ?? 0n).toBe(0n); // ₹5,000 alone is below ₹20,000

    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 30_000, date: fyDay(3), utr: 'V9', type: 'Visibility' }]));
    const plan = await (credits as any).buildPayoutTdsPlan(db, {
      clientId: CLIENT, period: thisPeriod(), outletTaxMap: new Map([['OUT1', taxInfo('ABCDE1234F')]]), runAt: NOW,
      currentMethodology: 'DEDUCT', importedCountFrom: null,
      engineEntries: [{ id: 'e1', outletId: 'OUT1', amountPaise: 500_000n, tdsSection: 'SEC_194R', tdsMethodology: 'DEDUCT' }],
    });
    // Threshold now met (₹35,000) → 10% of THIS payout only (₹500) — never the ₹3,000 on the off-portal ₹30,000.
    expect(plan.deductionByOutlet.get('OUT1')).toBe(50_000n);

    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, { resolveTdsPolicy: async () => ({ section: 'SEC_194R', methodology: 'DEDUCT' }) } as any);
    const { rows, summary } = await tds.report194R(CLIENT, FY.fyLabel);
    const row = rows.find((r) => r.panNumber === 'ABCDE1234F')!;
    expect(row).toMatchObject({ offPortalNotWithheldPaise: 3_000_000n, offPortalShortfallTdsPaise: 300_000n });
    expect(row.note).toMatch(/SHORTFALL ₹3,000\.00/);
    expect(row.note).toMatch(/NOT withheld from later portal payouts/);
    expect(summary).toMatchObject({ totalOffPortalShortfallTdsPaise: 300_000n });
  });

  it('194C Deduct: off-portal ₹2,00,000 crosses the 194C threshold; the next ₹10,000 portal payout withholds only its own 2%', async () => {
    const { svc, credits, db, invoices } = setup({ section: 'SEC_194C', methodology: 'DEDUCT' });
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 200_000, date: fyDay(3), utr: 'C9', type: 'Visibility' }]));
    expect(invoices.createTdsInvoice).not.toHaveBeenCalled(); // Deduct → nothing invoiced, nothing withheld
    const plan = await (credits as any).buildPayoutTdsPlan(db, {
      clientId: CLIENT, period: thisPeriod(), outletTaxMap: new Map([['OUT1', taxInfo('ABCDE1234F')]]), runAt: NOW,
      currentMethodology: 'DEDUCT', importedCountFrom: null,
      engineEntries: [{ id: 'e2', outletId: 'OUT1', amountPaise: 1_000_000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' }],
    });
    expect(plan.deductionByOutlet.get('OUT1')).toBe(20_000n); // 2% × ₹10,000 = ₹200 (not 2% × ₹2,10,000)
    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, {} as any);
    const [r] = await tds.compute194C(FY.fyLabel);
    expect(r).toMatchObject({ offPortalNotWithheldPaise: 20_000_000n, offPortalShortfallTdsPaise: 400_000n });
    expect(r.note).toMatch(/SHORTFALL ₹4,000\.00/);
  });

  it('owner 2026-11-26: a GROSS-UP 194C client\'s visibility rows are REFUSED — the whole file, listing the rows; nothing recorded or invoiced', async () => {
    const { svc, s, invoices } = setup({ section: 'SEC_194C', methodology: 'GROSS_UP' });
    const f = fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 1_000, date: fyDay(3), utr: 'I1', type: 'Incentive' },
      { id: 'OUT1', name: 'Sharma Stores', amount: 150_000, date: fyDay(3), utr: 'G9', type: 'Visibility' },
      { id: 'OUT2', name: 'Gupta Traders', amount: 9_000, date: fyDay(4), utr: 'G8', type: 'Visibility' },
    ]);
    await expect(svc.preview(gifsy(), f)).rejects.toMatchObject({
      response: { message: expect.stringMatching(/must be paid through the portal's payout flow, not recorded as off-portal\. Rows: 3, 4\./), details: { refusedRows: [3, 4] } },
    });
    await expect(svc.confirm(gifsy(), f, { fileSha256: 'a'.repeat(64), acknowledged: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(s.payments).toHaveLength(0);
    expect(invoices.createTdsInvoice).not.toHaveBeenCalled();
    expect(s.recoveries).toHaveLength(0);
    // Incentive-only files of the same client are fine (194R).
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 1_000, date: fyDay(3), utr: 'I1' }]));
    expect(s.payments).toHaveLength(1);
  });

  it('194C FY follows the payout PERIOD (A6): a March-period payment paid in April lands in the March FY', async () => {
    const { svc, db } = setup({ section: 'SEC_194C', methodology: 'DEDUCT' });
    const prevFyLabel = financialYear(new Date(FY.start.getTime() - 86_400_000)).fyLabel;
    const marchOfPrevFy = `${FY.start.getUTCFullYear()}-03`;
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 1_000, date: fyDay(3), utr: 'P1', type: 'Visibility', month: marchOfPrevFy }]));
    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, {} as any);
    expect(await tds.compute194C(FY.fyLabel)).toHaveLength(0);
    expect((await tds.compute194C(prevFyLabel))[0]).toMatchObject({ offPortalPaidPaise: 100_000n });
  });

  it('#4: no-PAN 194C Deduct is NOT a shortfall — recovered from the client with the outlet\'s next portal payment (report, preview, export agree)', async () => {
    const { svc, db, credits } = setup({ section: 'SEC_194C', methodology: 'DEDUCT' });
    const f = fileOf([{ id: 'OUT2', name: 'Gupta Traders', amount: 120_000, date: fyDay(3), utr: 'N7', type: 'Visibility' }]);
    const p = await svc.preview(gifsy(), f);
    expect(p.rows[0].tdsTreatment).toMatch(/no PAN: never withheld; recovered from the client/);
    await svc.confirm(gifsy(), f, { fileSha256: p.fileSha256, acknowledged: p.requiredAcknowledgements });
    const tds = new TdsService(db, { getForFy: async () => DEFAULT_RESOLVED_TDS_STATUTORY } as any, {} as any);
    const [r] = await tds.compute194C(FY.fyLabel);
    expect(r.offPortalNotWithheldPaise).toBeUndefined();
    expect(r.offPortalShortfallTdsPaise).toBeUndefined();
    expect(r.note).toMatch(/recovered from the client with this outlet's next portal payment \(not a shortfall\)/);
    expect(r.note).not.toMatch(/SHORTFALL/);
    // The outlet's next portal no-PAN payout: nothing at its BANK FILE (owner 2026-11-25 "TDS only on success")…
    const entry = { id: 'e3', outletId: 'OUT2', amountPaise: 500_000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' };
    const atFile = await (credits as any).buildPayoutTdsPlan(db, {
      clientId: CLIENT, period: p.rows[0].period, outletTaxMap: new Map(), runAt: NOW, currentMethodology: 'DEDUCT', importedCountFrom: null,
      engineEntries: [entry],
    });
    expect(atFile.noPanRecovery).toEqual([]);
    // …and when it is PAID the recovery is recorded on portal + off-portal (₹5,000 + ₹1,20,000 at 20/80) — the
    // off-portal no-PAN base is part of the PAID event's recovery base.
    const atPaid = await (credits as any).buildPayoutTdsPlan(db, {
      clientId: CLIENT, period: p.rows[0].period, outletTaxMap: new Map(), runAt: NOW, currentMethodology: 'DEDUCT', importedCountFrom: null,
      engineEntries: [entry], basis: 'PAID', excludeEntryIds: ['e3'],
    });
    expect(atPaid.noPanRecovery).toEqual([expect.objectContaining({ outletCode: 'OUT2', cumulativeBasePaise: 12_500_000n, tenantSharePaise: 3_125_000n })]);
    const x = await svc.exportXlsx(gifsy(), {});
    const XLSXr = await import('xlsx');
    const sheet = XLSXr.read(x.buffer, { type: 'buffer' }).Sheets['Off-portal payments'];
    expect(JSON.stringify(XLSXr.utils.sheet_to_json(sheet))).toMatch(/no PAN: recovered from the client \(not a shortfall\)/);
  });

  it('#5: void says how much TDS was already withheld from the SAME payee (exact key match) and that the next run nets it', async () => {
    const { svc, s, db } = setup({ section: 'SEC_194R', methodology: 'DEDUCT' });
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 30_000, date: fyDay(3), utr: 'V1', type: 'Visibility' }]));
    db.tdsDeductionEntry = {
      findMany: async ({ where }: any) =>
        [
          { clientId: CLIENT, section: 'SEC_194R', fyLabel: FY.fyLabel, panNumber: ' abcde1234f ', tdsDeductedThisPaise: 50_000n }, // same PAN, other spelling
          { clientId: CLIENT, section: 'SEC_194R', fyLabel: FY.fyLabel, panNumber: 'ABCDE1234G', tdsDeductedThisPaise: 70_000n }, // another payee
        ].filter((r) => matches(r, where)),
    };
    const r = await svc.void(gifsy(), s.payments[0].id, 'recorded by mistake');
    expect(r.message).toMatch(/₹500\.00 TDS was already withheld \(194R\)/);
    expect(r.message).toMatch(/the next payout run nets that against what was already withheld/);
    expect(r.message).not.toMatch(/₹1,200/);
  });
});

describe('fund — gifts carry no agency fee (A8)', () => {
  it('a gift line is charged at face with GIFT_NO_AGENCY_FEE; a cash line gets the fee', () => {
    const at = new Date(FY.start.getTime() + 86_400_000);
    const row = { id: 'g', outletCode: 'OUT1', outletName: 'S', amountPaise: 100_000n, paymentDate: at, utr: null, payoutStream: 'INCENTIVE', period: '2026-04', voidedAt: null };
    const rates = [{ kind: 'AGENCY_FEE' as const, feeType: 'PERCENT' as const, rateBps: 500, effectiveFrom: new Date(0), createdAt: new Date(0) }];
    const st = buildFundStatement({ items: [offPortalItem({ ...row, paymentMode: 'GIFT' }), offPortalItem({ ...row, id: 'c', paymentMode: 'CASH' })], entries: [], rates });
    const gift = st.lines.find((l) => l.source.id === 'g')!;
    const cash = st.lines.find((l) => l.source.id === 'c')!;
    expect(gift).toMatchObject({ feePaise: 0n, chargedPaise: 100_000n, flags: ['GIFT_NO_AGENCY_FEE'] });
    expect(cash).toMatchObject({ feePaise: 5_000n });
  });
});

describe('credits confirm — "Before you confirm" warns about a possible duplicate of an off-portal payment (A5)', () => {
  it('a PAYOUT row of the same outlet + amount for the month → OFF_PORTAL_DUPLICATE item', async () => {
    const { svc, credits, db } = setup();
    await previewAndConfirm(svc, fileOf([{ id: 'OUT1', name: 'Sharma Stores', amount: 2_500, date: fyDay(3), utr: 'Z1' }]));
    const period = s0Period(fyDay(3));
    const req = await (credits as any).presentAckItems(db, CLIENT, 'b1', period, [
      { outletId: 'OUT1', fieldId: 'f1', fieldName: 'Incentive', amount: 250_000, awardType: 'PAYOUT', status: 'OK' },
      { outletId: 'OUT1', fieldId: 'f1', fieldName: 'Incentive', amount: 999, awardType: 'PAYOUT', status: 'OK' },
    ], []);
    expect(req.OFF_PORTAL_DUPLICATE).toHaveLength(1);
    expect(req.OFF_PORTAL_DUPLICATE[0].text).toMatch(/possible duplicate of an off-portal payment/);
  });
});

/** "DD/MM/YYYY" → "YYYY-MM". */
function s0Period(ddmmyyyy: string): string {
  return `${ddmmyyyy.slice(6, 10)}-${ddmmyyyy.slice(3, 5)}`;
}

describe('upload history shows voided counts (B8)', () => {
  it('Recorded N · voided M · counting N − M', async () => {
    const { svc, s, db } = setup();
    db.offPortalPayment.groupBy = async ({ where }: any) => {
      const rows = s.payments.filter((p) => matches(p, where));
      const by = new Map<string, any[]>();
      for (const r of rows) by.set(r.uploadId, [...(by.get(r.uploadId) ?? []), r]);
      return [...by].map(([uploadId, rs]) => ({ uploadId, _count: { _all: rs.length }, _sum: { amountPaise: rs.reduce((a: bigint, r: any) => a + r.amountPaise, 0n) } }));
    };
    await previewAndConfirm(svc, fileOf([
      { id: 'OUT1', name: 'Sharma Stores', amount: 100, date: fyDay(3), utr: 'A' },
      { id: 'OUT1', name: 'Sharma Stores', amount: 200, date: fyDay(30), utr: 'B' },
    ]));
    await svc.void(gifsy(), s.payments[0].id, 'entered twice');
    const [u] = await svc.uploads(gifsy());
    expect(u).toMatchObject({ recordedCount: 2, voidedCount: 1, countingCount: 1, countingPaise: '20000' });
  });
});
