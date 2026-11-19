/**
 * TDS deposits — "TDS for month" (owner-approved platform-wide money fixes A, B, D; 2026-11-12).
 *
 *  A. A deposit is assigned to the FY of the MONTH IT PAYS FOR (TdsDeposit.forPeriod, YYYY-MM),
 *     not the FY of its deposit date. Default when the upload gives no month: deposit day ≤ 7 →
 *     previous month; 8–30 April → March of the same year; otherwise the deposit's own month.
 *  B. 194C WITHHELD-only rows appear for real PANs too (not only when a deposit exists) — no dups.
 *  D. 194C base-less rows carry the PAN's REAL entity type (1% vs 2% in the export); a no-PAN
 *     deposit linked to a known deductee gets that deductee's row, never the "not linked" row.
 *
 * All dates are computed relative to "now" (never a hard-coded future date).
 *
 * Run: npx jest src/tds/tds.deposit-period.spec.ts
 */
import * as XLSX from 'xlsx';
import { createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService, UNLINKED_NO_PAN_DEPOSIT_KEY, UNLINKED_NO_PAN_DEPOSIT_LABEL } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import {
  DEFAULT_RESOLVED_TDS_STATUTORY,
  DEPOSIT_FOR_MONTH_HEADER,
  buildDepositTemplate,
  defaultDepositForPeriod,
  depositFileHash,
  formatForPeriod,
  parseDepositUpload,
  parseForPeriodCell,
  parseDateCell,
  parseOffPlatformUpload,
  fyLabelForPeriod,
  type ParsedDepositRow,
} from './tds.helpers';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
const mockTdsTenantSettings = {
  resolveTdsPolicy: jest.fn().mockResolvedValue({ section: 'SEC_194C', methodology: 'GROSS_UP' }),
};

// ─── Relative calendar ───────────────────────────────────────────────────────

const now = new Date();
/** The FY under test = the PREVIOUS FY (so its March and the following April are both in the past). */
const curFyStart = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const Y = curFyStart - 1; // FY Y-(Y+1)
const fyLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const FY = fyLabel(Y);
const NEXT_FY = fyLabel(Y + 1);
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)); // UTC midnight = IST same date
const pad = (n: number) => String(n).padStart(2, '0');
const MARCH = `${Y + 1}-03`;
const APRIL_NEXT = `${Y + 1}-04`;

// ─── Prisma mock that EMULATES the deposit where-clause the service sends ────

type DepositFx = {
  section: 'SEC_194R' | 'SEC_194C';
  clientId: string | null;
  panNumber: string;
  outletCode?: string | null;
  amountPaise: bigint;
  depositDate: Date;
  forPeriod?: string | null;
};
let depositRows: DepositFx[] = [];

function matchDeposit(d: DepositFx, w: Record<string, any>): boolean {
  if (w.section && d.section !== w.section) return false;
  if ('clientId' in w && d.clientId !== w.clientId) return false;
  if (Array.isArray(w.OR)) {
    return w.OR.some((c: any) => {
      if (c.forPeriod === null) {
        if (d.forPeriod != null) return false;
        const r = c.depositDate;
        return (!r?.gte || d.depositDate >= r.gte) && (!r?.lt || d.depositDate < r.lt);
      }
      const r = c.forPeriod;
      return d.forPeriod != null && (!r.gte || d.forPeriod >= r.gte) && (!r.lte || d.forPeriod <= r.lte);
    });
  }
  return true;
}

const mockPrisma = {
  // tdsImportedPayouts setting read (fail-closed): no row → OFF.
  programSetting: { findUnique: jest.fn(), findMany: jest.fn() }, // findMany: the loops below reset every model's findMany
  creditPayoutEntry: { findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  tdsOffPlatformEntry: { findMany: jest.fn() },
  tdsDeposit: { findMany: jest.fn(), createMany: jest.fn() },
  tdsDeductionEntry: { findMany: jest.fn() },
  // WRE (merge decision A): open 194R TDS credits — none here.
  tdsCredit: { findMany: jest.fn(async () => []) },
  tdsRecoveryEntry: { findMany: jest.fn() },
};
const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };

interface PartnerFx { id: string; pan: string | null; owner: string; outlets: string[]; entityType?: string | null }
let partners: PartnerFx[] = [];
const CLIENT = 'deoleo';

function wire() {
  mockPrisma.tdsDeposit.findMany.mockImplementation(async (args: { where: Record<string, any> }) =>
    depositRows.filter((d) => matchDeposit(d, args.where)),
  );
  const outletRows = partners.flatMap((p) =>
    p.outlets.map((o) => ({ outletCode: o, partnerId: p.id, clientId: CLIENT, name: `${o}-name` })),
  );
  mockPrisma.outlet.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    return outletRows.filter((o) => {
      if (typeof w.clientId === 'string' && o.clientId !== w.clientId) return false;
      if (w.clientId?.in && !w.clientId.in.includes(o.clientId)) return false;
      if (w.partnerId?.in && !w.partnerId.in.includes(o.partnerId)) return false;
      if (w.outletCode?.in && !w.outletCode.in.includes(o.outletCode)) return false;
      if (Array.isArray(w.OR)) {
        return w.OR.some((c: any) => String(c.outletCode?.equals ?? '').toUpperCase() === o.outletCode.toUpperCase());
      }
      return true;
    });
  });
  mockPrisma.channelPartner.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    return partners
      .filter((p) => !w.id?.in || w.id.in.includes(p.id))
      .filter((p) => !w.panNumber?.in || w.panNumber.in.includes(p.pan))
      .filter(
        (p) =>
          !Array.isArray(w.OR) ||
          w.OR.some((c: any) => String(c.panNumber?.equals ?? '').toUpperCase() === String(p.pan ?? '').toUpperCase()),
      )
      .filter((p) => !(w.entityType?.not === null) || p.entityType != null)
      .map((p) => ({
        id: p.id,
        clientId: CLIENT,
        panNumber: p.pan,
        entityType: p.entityType === undefined ? 'INDIVIDUAL' : p.entityType,
        ownerName: p.owner,
        businessName: `${p.owner} Stores`,
      }));
  });
}

let seq = 0;
/** A PAID incentive (194R) payout entry dated `paidAt`. */
const incentive = (outletId: string, amountPaise: bigint, paidAt: Date) => ({
  id: `e${++seq}`, amountPaise, fieldId: 'F-INC', outletId, paidAt,
  period: `${paidAt.getUTCFullYear()}-${pad(paidAt.getUTCMonth() + 1)}`,
  status: 'PAID', clientId: CLIENT, tdsSection: null, tdsMethodology: null,
});
/** A PAID visibility (194C) payout entry for `period`. */
const visibility = (outletId: string, amountPaise: bigint, period: string) => ({
  id: `v${++seq}`, amountPaise, fieldId: 'F-VIS', outletId, paidAt: new Date(), period,
  status: 'PAID', clientId: CLIENT, tdsSection: null, tdsMethodology: null,
});

function parseSheet(buffer: Buffer, idx = 0) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[idx]]);
}
function xlsxAb(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
const multer = (ab: ArrayBuffer) => ({ buffer: Buffer.from(ab) }) as Express.Multer.File;

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

describe('defaultDepositForPeriod (owner rule)', () => {
  it.each([
    [ymd(Y + 1, 4, 1), MARCH],          // day ≤ 7 → previous month
    [ymd(Y + 1, 4, 7), MARCH],          // 7 April → March
    [ymd(Y + 1, 4, 8), MARCH],          // 8–30 April → March of the same year
    [ymd(Y + 1, 4, 25), MARCH],
    [ymd(Y + 1, 4, 30), MARCH],
    [ymd(Y + 1, 5, 1), APRIL_NEXT],     // 1 May → April
    [ymd(Y + 1, 5, 7), APRIL_NEXT],
    [ymd(Y + 1, 5, 8), `${Y + 1}-05`],  // otherwise own month
    [ymd(Y + 1, 1, 5), `${Y}-12`],      // January 1–7 → December of the previous year
    [ymd(Y + 1, 3, 15), MARCH],
    [ymd(Y, 7, 31), `${Y}-07`],
  ])('%s → %s', (date, expected) => {
    expect(defaultDepositForPeriod(date)).toBe(expected);
  });

  it('uses the IST date (19:00 UTC on the 7th = the 8th in IST)', () => {
    // 7 May 19:00 UTC = 8 May 00:30 IST → May (UTC calendar would have said "7th → April").
    expect(defaultDepositForPeriod(new Date(Date.UTC(Y + 1, 4, 7, 19, 0)))).toBe(`${Y + 1}-05`);
  });
});

describe('parseForPeriodCell', () => {
  it.each([
    ['2026-03', '2026-03'],
    ['2026/3', '2026-03'],
    ['03/2026', '2026-03'],
    ['Mar-2026', '2026-03'],
    ['mar 2026', '2026-03'],
    ['March 2026', '2026-03'],
    ['Mar-26', '2026-03'],
    ["Sept'25", '2025-09'],
    ['2026-03-15', '2026-03'],
    ['15/03/2026', '2026-03'],
  ])('%s → %s', (raw, expected) => {
    expect(parseForPeriodCell(raw)).toEqual({ period: expected });
  });

  it('an Excel date cell (serial) → its month', () => {
    // 2026-03-15 as an Excel serial
    const serial = Math.round((Date.UTC(2026, 2, 15) - Date.UTC(1899, 11, 30)) / 86_400_000);
    expect(parseForPeriodCell(serial)).toEqual({ period: '2026-03' });
  });

  it('blank → { blank }', () => {
    expect(parseForPeriodCell('')).toEqual({ blank: true });
    expect(parseForPeriodCell('   ')).toEqual({ blank: true });
    expect(parseForPeriodCell(undefined)).toEqual({ blank: true });
  });

  it.each(['2026-13', '2026-00', 'Foo-2026', 'abc', '1999-03', '13/2026', 5])('rejects %s', (raw) => {
    expect('error' in (parseForPeriodCell(raw) as object)).toBe(true);
  });
});

describe('deposit template + parser — "TDS for month" column', () => {
  const header = ['Date', 'Outlet Code', 'PAN', 'Amount (₹)', DEPOSIT_FOR_MONTH_HEADER];
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it('both templates carry the optional "TDS for month" column', () => {
    for (const s of ['194R', '194C'] as const) {
      const wb = XLSX.read(buildDepositTemplate(s), { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      expect(aoa[0]).toContain('TDS for month');
    }
  });

  it('explicit month is used (overrides the default rule)', () => {
    const { rows, result } = parseDepositUpload(
      xlsxAb([header, [iso(ymd(Y + 1, 4, 7)), '', 'ABCDE1234F', 1000, `${Y + 1}-04`]]),
    );
    expect(result.failed).toBe(0);
    expect(rows[0]).toMatchObject({ forPeriod: APRIL_NEXT, forPeriodExplicit: true });
  });

  it('blank month → default rule; a default that lands in an earlier FY is noted in warnings', () => {
    const { rows, result } = parseDepositUpload(
      xlsxAb([
        header,
        [iso(ymd(Y + 1, 4, 7)), '', 'ABCDE1234F', 1000, ''],
        [iso(ymd(Y + 1, 4, 25)), '', 'ABCDE1234F', 500, ''],
        [iso(ymd(Y, 8, 20)), '', 'ABCDE1234F', 700, ''],
      ]),
    );
    expect(rows.map((r) => [r.forPeriod, r.forPeriodExplicit])).toEqual([
      [MARCH, false],
      [MARCH, false],
      [`${Y}-08`, false],
    ]);
    // Only the two April deposits move FY → two notes, both naming the FY.
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings![0].message).toContain(`FY ${FY}`);
  });

  it('file WITHOUT the column → default rule, identical file hash to before the change', () => {
    const { rows } = parseDepositUpload(
      xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)'], [iso(ymd(Y, 9, 15)), 'OUT1', 'ABCDE1234F', 1000]]),
    );
    expect(rows[0]).toMatchObject({ forPeriod: `${Y}-09`, forPeriodExplicit: false });
    // Pre-change canonical form (no forPeriod element) → re-upload of an older file still dedups.
    const legacy = `DEP-${createHash('sha256')
      .update([rows[0].depositDate.toISOString(), 'ABCDE1234F', '100000', 'OUT1'].join('\u0001'))
      .digest('hex')}`;
    expect(depositFileHash(rows)).toBe(legacy);
    // An explicit month changes the hash (it is file content).
    const explicit: ParsedDepositRow[] = [{ ...rows[0], forPeriod: `${Y}-08`, forPeriodExplicit: true }];
    expect(depositFileHash(explicit)).not.toBe(legacy);
  });

  it('rejects a future month, a month after the deposit month, and an unreadable month (row errors)', () => {
    const today = new Date();
    const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1));
    const future = `${nextMonth.getUTCFullYear()}-${pad(nextMonth.getUTCMonth() + 1)}`;
    const { rows, result } = parseDepositUpload(
      xlsxAb([
        header,
        [iso(today), '', 'ABCDE1234F', 1000, future],
        [iso(ymd(Y, 6, 10)), '', 'ABCDE1234F', 1000, `${Y}-07`],
        [iso(ymd(Y, 6, 10)), '', 'ABCDE1234F', 1000, 'Smarch-2025'],
        [iso(ymd(Y, 6, 10)), '', 'ABCDE1234F', 1000, `${Y}-13`],
      ]),
    );
    expect(rows).toHaveLength(0);
    expect(result.failed).toBe(4);
    expect(result.errors[0].message).toMatch(/Row 2: .*is in the future/);
    expect(result.errors[1].message).toMatch(/Row 3: .*after the deposit date's month/);
    expect(result.errors[2].message).toMatch(/Row 4: invalid TDS for month/);
    expect(result.errors[3].message).toMatch(/Row 5: invalid TDS for month/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Service
// ═════════════════════════════════════════════════════════════════════════════

describe('TdsService — deposits by "TDS for month" FY', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    seq = 0;
    depositRows = [];
    partners = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
        // D6: the 194R report reads the client's CURRENT methodology (default policy = GROSS_UP).
        { provide: TenantSettingsService, useValue: mockTdsTenantSettings },
      ],
    }).compile();
    service = module.get(TdsService);
    for (const m of Object.values(mockPrisma)) {
      m.findMany.mockResolvedValue([]);
    }
    mockPrisma.creditField.findMany.mockImplementation(async (args: { where: Record<string, any> }) =>
      args.where.payoutStream === 'VISIBILITY' ? [{ id: 'F-VIS', clientId: CLIENT }] : [],
    );
  });

  /** 194R fixture: PAN A paid ₹30,000 in March of FY (liability 10/90 = ₹3,333). */
  function marchPayoutFixture() {
    partners = [{ id: 'pA', pan: 'AAAAA1111A', owner: 'Asha', outlets: ['OA'] }];
    wire();
    mockPrisma.creditPayoutEntry.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
      const e = incentive('OA', 3_000_000n, ymd(Y + 1, 3, 20));
      const r = args.where.paidAt;
      return r && e.paidAt >= r.gte && e.paidAt < r.lt ? [e] : [];
    });
  }

  it('194R: March TDS deposited 7 Apr and 25 Apr (no month given) counts in the MARCH FY, not the next', async () => {
    marchPayoutFixture();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 200_000n, depositDate: ymd(Y + 1, 4, 7) },
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 133_300n, depositDate: ymd(Y + 1, 4, 25) },
    ];

    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      panNumber: 'AAAAA1111A',
      liabilityPaise: 333_300n,
      depositedPaise: 333_300n,
      outstandingPaise: 0n,
      depositForPeriods: [MARCH],
    });

    // …and the NEXT FY no longer shows a negative deposit-only row for it.
    const next = await service.compute194R(CLIENT, NEXT_FY);
    expect(next).toEqual([]);
  });

  it('194R: the backfilled forPeriod (stored) behaves exactly like the default rule', async () => {
    marchPayoutFixture();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 333_300n, depositDate: ymd(Y + 1, 4, 7), forPeriod: MARCH },
    ];
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows[0]).toMatchObject({ depositedPaise: 333_300n, outstandingPaise: 0n });
    expect(await service.compute194R(CLIENT, NEXT_FY)).toEqual([]);
  });

  it('194R: an explicit forPeriod overrides the default (7 Apr deposit FOR April → next FY)', async () => {
    marchPayoutFixture();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 100_000n, depositDate: ymd(Y + 1, 4, 7), forPeriod: APRIL_NEXT },
    ];
    const fyRows = await service.compute194R(CLIENT, FY);
    expect(fyRows[0]).toMatchObject({ depositedPaise: 0n, outstandingPaise: 333_300n });
    expect(fyRows[0].depositForPeriods).toBeUndefined();

    const next = await service.compute194R(CLIENT, NEXT_FY);
    expect(next).toEqual([
      expect.objectContaining({
        panNumber: 'AAAAA1111A',
        baseFyTotalPaise: 0n,
        depositedPaise: 100_000n,
        outstandingPaise: -100_000n,
        depositForPeriods: [APRIL_NEXT],
      }),
    ]);
  });

  it('194R: a deposit-only PAN (deposit for this FY, nothing paid this FY) still gets its row; totals = Σ rows', async () => {
    marchPayoutFixture();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 333_300n, depositDate: ymd(Y + 1, 4, 5) },
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'BBBBB2222B', amountPaise: 50_000n, depositDate: ymd(Y, 11, 3) },
    ];
    const rows = await service.compute194R(CLIENT, FY);
    const b = rows.find((r) => r.panNumber === 'BBBBB2222B')!;
    expect(b).toMatchObject({ baseFyTotalPaise: 0n, depositedPaise: 50_000n, outstandingPaise: -50_000n, depositForPeriods: [`${Y}-10`] });

    const summary = (await service.report194R(CLIENT, FY)).summary;
    expect(summary.totalDepositedPaise).toBe(rows.reduce((s, r) => s + r.depositedPaise, 0n));
    expect(summary.totalOutstandingPaise).toBe(rows.reduce((s, r) => s + r.outstandingPaise, 0n));
    expect(summary.totalOutstandingPaise).toBe(-50_000n);
  });

  it('DEOLEO COMMON CASE: deposits dated inside the FY they cover (any day May–March) are counted exactly as before', async () => {
    marchPayoutFixture();
    // Every one of these is in FY by its deposit DATE (the old rule) AND by its TDS-for-month (new rule).
    const dates = [ymd(Y, 5, 1), ymd(Y, 5, 7), ymd(Y, 5, 8), ymd(Y, 8, 7), ymd(Y, 12, 31), ymd(Y + 1, 1, 3), ymd(Y + 1, 3, 31)];
    depositRows = dates.map((d, i) => ({
      section: 'SEC_194R' as const, clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: BigInt((i + 1) * 1000), depositDate: d,
    }));
    const oldRuleTotal = depositRows.reduce((s, d) => s + d.amountPaise, 0n); // all dated within FY
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].depositedPaise).toBe(oldRuleTotal);
    expect(rows[0].outstandingPaise).toBe(333_300n - oldRuleTotal);
    // …and none of them leaks into the neighbouring FYs.
    expect(await service.compute194R(CLIENT, NEXT_FY)).toEqual([]);
    expect(await service.compute194R(CLIENT, fyLabel(Y - 1))).toEqual([]);
  });

  it('the deposit query selects by the forPeriod FY window, with a depositDate fallback only for rows lacking forPeriod', async () => {
    marchPayoutFixture();
    await service.compute194R(CLIENT, FY);
    const where = mockPrisma.tdsDeposit.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ section: 'SEC_194R', clientId: CLIENT });
    expect(where.OR[0]).toEqual({ forPeriod: { gte: `${Y}-04`, lte: `${Y + 1}-03` } });
    expect(where.OR[1].forPeriod).toBeNull();
    expect(where).not.toHaveProperty('depositDate');
  });

  it('194R: a no-PAN deposit linked to a KNOWN no-PAN deductee with no base this FY → that deductee\'s row, not "not linked"', async () => {
    partners = [{ id: 'pN', pan: null, owner: 'Nita', outlets: ['ON'] }];
    wire();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'ON', amountPaise: 40_000n, depositDate: ymd(Y, 9, 15) },
    ];
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].unlinkedNoPanDeposit).toBeUndefined();
    expect(rows[0]).toMatchObject({ panNumber: '__NO_PAN__:pN', depositedPaise: 40_000n, outstandingPaise: -40_000n });
    expect(rows[0].noPanDeductee?.name).toBe('Nita');

    const sheet = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(sheet[0]['Deductee Name']).toBe('Nita (NO PAN ON FILE)');
    expect(sheet[0]['Deductee Name']).not.toBe(UNLINKED_NO_PAN_DEPOSIT_LABEL);
  });

  it('194R: a no-PAN deposit that cannot be linked still lands on the "Earlier no-PAN deposits" row', async () => {
    wire();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'UNKNOWN', amountPaise: 10_000n, depositDate: ymd(Y, 9, 15) },
    ];
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toEqual([expect.objectContaining({ panNumber: UNLINKED_NO_PAN_DEPOSIT_KEY, unlinkedNoPanDeposit: true, depositedPaise: 10_000n })]);
  });

  it('194R export: "Deposits — TDS for Month(s)" column shows the months', async () => {
    marchPayoutFixture();
    depositRows = [
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 100_000n, depositDate: ymd(Y + 1, 3, 6) },
      { section: 'SEC_194R', clientId: CLIENT, panNumber: 'AAAAA1111A', amountPaise: 233_300n, depositDate: ymd(Y + 1, 4, 7) },
    ];
    const sheet = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(sheet[0]['Deposits — TDS for Month(s)']).toBe(`${formatForPeriod(`${Y + 1}-02`)}, ${formatForPeriod(MARCH)}`);
    const liab = await service.getLiability('194R', FY, CLIENT);
    expect(liab.rows[0].depositForPeriods).toEqual([`${Y + 1}-02`, MARCH]);
  });

  // ─── 194C ────────────────────────────────────────────────────────────────────

  it('194C: March-period TDS deposited 7 Apr counts in the March FY', async () => {
    partners = [{ id: 'pC', pan: 'CCCCC3333C', owner: 'Chetan', outlets: ['OC'], entityType: 'COMPANY' }];
    wire();
    mockPrisma.creditPayoutEntry.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
      const e = visibility('OC', 4_000_000n, MARCH);
      const r = args.where.period;
      return r && e.period >= r.gte && e.period <= r.lte ? [e] : [];
    });
    depositRows = [
      { section: 'SEC_194C', clientId: null, panNumber: 'CCCCC3333C', amountPaise: 81_600n, depositDate: ymd(Y + 1, 4, 7) },
    ];
    const rows = await service.compute194C(FY);
    expect(rows[0]).toMatchObject({ panNumber: 'CCCCC3333C', depositedPaise: 81_600n, depositForPeriods: [MARCH] });
    expect(await service.compute194C(NEXT_FY)).toEqual([]);
    const where = mockPrisma.tdsDeposit.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('clientId'); // 194C stays platform-wide
  });

  it('194C (B): a WITHHELD-only real PAN gets its own row with its real entity type (D); totals = Σ rows', async () => {
    partners = [{ id: 'pI', pan: 'IIIII4444I', owner: 'Indu', outlets: ['OI'], entityType: 'INDIVIDUAL' }];
    wire();
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: 'IIIII4444I', tdsDeductedThisPaise: 30_000n }]);

    const rows = await service.compute194C(FY);
    expect(rows).toEqual([
      expect.objectContaining({
        panNumber: 'IIIII4444I',
        entityType: 'INDIVIDUAL',
        baseFyTotalPaise: 0n,
        withheldPaise: 30_000n,
        depositedPaise: 0n,
        outstandingPaise: -30_000n,
      }),
    ]);
    const summary = await service.summary194C(FY);
    expect(summary.totalWithheldPaise).toBe(30_000n);
    expect(summary.totalOutstandingPaise).toBe(-30_000n);

    const sheet = parseSheet((await service.export194C(FY)).buffer);
    expect(sheet[0]['Entity Type']).toBe('INDIVIDUAL');
    expect(sheet[0]['TDS Rate %']).toBe(1);
  });

  it('194C: a PAN with deposit AND withholding but no base → ONE row carrying both (no duplicate)', async () => {
    partners = [{ id: 'pH', pan: 'HHHHH5555H', owner: 'Hari', outlets: ['OH'], entityType: 'HUF' }];
    wire();
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: 'HHHHH5555H', tdsDeductedThisPaise: 10_000n }]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([{ panNumber: 'HHHHH5555H', clientId: CLIENT, tenantSharePaise: 5_000n }]);
    depositRows = [
      { section: 'SEC_194C', clientId: null, panNumber: 'HHHHH5555H', amountPaise: 20_000n, depositDate: ymd(Y, 10, 15) },
    ];
    const rows = await service.compute194C(FY);
    expect(rows.filter((r) => r.panNumber === 'HHHHH5555H')).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'HUF',
      depositedPaise: 20_000n,
      withheldPaise: 10_000n,
      recoveredPaise: 5_000n,
      outstandingPaise: -30_000n,
      recoveryByTenant: [{ clientId: CLIENT, tenantSharePaise: 5_000n }],
    });
  });

  it('194C (D): a deposit-only PAN unknown to any partner stays OTHERS (2%)', async () => {
    wire();
    depositRows = [
      { section: 'SEC_194C', clientId: null, panNumber: 'ZZZZZ9999Z', amountPaise: 20_000n, depositDate: ymd(Y, 10, 15) },
    ];
    const rows = await service.compute194C(FY);
    expect(rows[0]).toMatchObject({ panNumber: 'ZZZZZ9999Z', entityType: 'OTHERS' });
    const sheet = parseSheet((await service.export194C(FY)).buffer);
    expect(sheet[0]['TDS Rate %']).toBe(2);
    expect(sheet[0]['Deposits — TDS for Month(s)']).toBe(formatForPeriod(`${Y}-10`));
  });

  it('194C: a no-PAN deposit linked to a known outlet with no base → that outlet\'s deductee row (named), not "not linked"', async () => {
    partners = [{ id: 'pQ', pan: null, owner: 'Qadir', outlets: ['OQ'] }];
    wire();
    depositRows = [
      { section: 'SEC_194C', clientId: CLIENT, panNumber: '__NO_PAN__', outletCode: 'OQ', amountPaise: 9_000n, depositDate: ymd(Y, 10, 15) },
    ];
    const rows = await service.compute194C(FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].unlinkedNoPanDeposit).toBeUndefined();
    expect(rows[0]).toMatchObject({ panNumber: `__NO_PAN__:outlet:${CLIENT}:OQ`, depositedPaise: 9_000n, outstandingPaise: -9_000n });
    expect(rows[0].noPanDeductee?.name).toBe('Qadir');
  });

  it('FY of a period is consistent with the payout anchor (fyLabelForPeriod)', () => {
    expect(fyLabelForPeriod(MARCH)).toBe(FY);
    expect(fyLabelForPeriod(APRIL_NEXT)).toBe(NEXT_FY);
  });
});

describe('TdsService.uploadDeposit — stores forPeriod; dedup is per (…, forPeriod)', () => {
  let service: TdsService;
  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
        // D6: the 194R report reads the client's CURRENT methodology (default policy = GROSS_UP).
        { provide: TenantSettingsService, useValue: mockTdsTenantSettings },
      ],
    }).compile();
    service = module.get(TdsService);
    for (const m of Object.values(mockPrisma)) m.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.createMany.mockResolvedValue({ count: 0 });
  });

  const header = ['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'TDS for month'];
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it('writes the explicit / defaulted forPeriod; two rows differing only by month are BOTH inserted', async () => {
    const d = iso(ymd(Y + 1, 4, 7));
    const ab = xlsxAb([
      header,
      [d, '', 'ABCDE1234F', 1000, `${Y + 1}-02`],
      [d, '', 'ABCDE1234F', 1000, ''], // default → March
    ]);
    const res = await service.uploadDeposit('194R', CLIENT, 'u1', multer(ab), true);
    expect(res.succeeded).toBe(2);
    const data = mockPrisma.tdsDeposit.createMany.mock.calls[0][0].data;
    expect(data.map((r: { forPeriod: string }) => r.forPeriod)).toEqual([`${Y + 1}-02`, MARCH]);
  });

  it('a stored row with NO forPeriod (older build) dedups against the re-upload via the default rule', async () => {
    const d = ymd(Y + 1, 4, 7);
    const ab = xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)'], [iso(d), '', 'ABCDE1234F', 1000]]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValueOnce([
      { panNumber: 'ABCDE1234F', depositDate: d, amountPaise: 100_000n, outletCode: null, forPeriod: null },
    ]);
    const res = await service.uploadDeposit('194R', CLIENT, 'u1', multer(ab), true);
    expect(res.skipped).toBe(1);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit fixes: day-first dates, header variants, month sanity, cross-upload duplicates
// ═════════════════════════════════════════════════════════════════════════════

describe('parseDateCell — Indian day-first text dates, never new Date(string)', () => {
  const APR7 = new Date(Date.UTC(2026, 3, 7)).toISOString();
  it.each(['07/04/2026', '7/4/2026', '07-04-2026', '07.04.2026', '07/04/26', '07-Apr-2026', '7 April 2026', '07 apr 26', '2026-04-07'])(
    '%s → 7 April 2026',
    (s) => {
      expect(parseDateCell(s)?.toISOString()).toBe(APR7);
    },
  );

  it('13/04/2026 → 13 April 2026', () => {
    expect(parseDateCell('13/04/2026')?.toISOString()).toBe(new Date(Date.UTC(2026, 3, 13)).toISOString());
  });

  it('a zone-less time is India time: "2026-04-30 20:00" = 14:30 UTC, still 30 April → March TDS', () => {
    const d = parseDateCell('2026-04-30 20:00')!;
    expect(d.toISOString()).toBe('2026-04-30T14:30:00.000Z');
    expect(defaultDepositForPeriod(d)).toBe('2026-03');
    expect(parseDateCell('30/04/2026 20:00')!.toISOString()).toBe('2026-04-30T14:30:00.000Z');
  });

  it('an explicit zone is honoured: "2026-04-30T20:00:00Z" = 1 May 01:30 IST → April TDS', () => {
    const d = parseDateCell('2026-04-30T20:00:00Z')!;
    expect(d.toISOString()).toBe('2026-04-30T20:00:00.000Z');
    expect(defaultDepositForPeriod(d)).toBe('2026-04');
    expect(parseDateCell('2026-04-30T20:00+05:30')!.toISOString()).toBe('2026-04-30T14:30:00.000Z');
  });

  it.each(['04/31/2026', '31/02/2026', '13/13/2026', 'April 7, 2026', 'Apr 7 2026', '2026/04/07', '7th April 2026', 'yesterday', '07/04/2026 25:00'])(
    'rejects %s',
    (s) => {
      expect(parseDateCell(s)).toBeNull();
    },
  );

  it('an Excel date serial still works', () => {
    const serial = Math.round((Date.UTC(2026, 3, 7) - Date.UTC(1899, 11, 30)) / 86_400_000);
    expect(parseDateCell(serial)?.toISOString()).toBe(APR7);
  });

  it('parseForPeriodCell reads a full date day-first too (07/04/2026 → April, not July)', () => {
    expect(parseForPeriodCell('07/04/2026')).toEqual({ period: '2026-04' });
    expect(parseForPeriodCell('2026-04-30 20:00')).toEqual({ period: '2026-04' });
    expect(parseForPeriodCell('07-Apr-2026')).toEqual({ period: '2026-04' });
  });

  it('both upload parsers read "07/04/<year>" as 7 April', () => {
    const y = curFyStart; // this FY's April — already started, never in the future
    const dep = parseDepositUpload(xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)'], [`07/04/${y}`, '', 'ABCDE1234F', 1000]]));
    expect(dep.rows[0].depositDate.toISOString()).toBe(new Date(Date.UTC(y, 3, 7)).toISOString());
    expect(dep.rows[0].forPeriod).toBe(`${y}-03`);
    const off = parseOffPlatformUpload(xlsxAb([['Date', 'PAN', 'Outlet Code', 'Amount (₹)'], [`07/04/${y}`, 'ABCDE1234F', '', 1000]]));
    expect(off.rows[0].entryDate.toISOString()).toBe(new Date(Date.UTC(y, 3, 7)).toISOString());
  });
});

describe('deposit parser — header variants, month sanity checks', () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const depAug = iso(ymd(Y, 8, 20));

  it.each(['TDS for month', 'TDS for Month (YYYY-MM)', 'For month', 'Period', '  tds  FOR   month ', 'PERIOD'])(
    'header "%s" is the TDS-for-month column',
    (h) => {
      const { rows } = parseDepositUpload(xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)', h], [depAug, '', 'ABCDE1234F', 1000, `${Y}-07`]]));
      expect(rows[0]).toMatchObject({ forPeriod: `${Y}-07`, forPeriodExplicit: true });
    },
  );

  it('an extra month-like column is ignored with a warning', () => {
    const { rows, result } = parseDepositUpload(
      xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'TDS for month', 'Payment Month'], [depAug, '', 'ABCDE1234F', 1000, `${Y}-07`, `${Y}-06`]]),
    );
    expect(rows[0].forPeriod).toBe(`${Y}-07`);
    expect(result.warnings).toEqual([expect.objectContaining({ row: 1, message: expect.stringContaining('"Payment Month" was ignored') })]);
  });

  it('an unrecognised month-like column → warning, and the default rule applies', () => {
    const { rows, result } = parseDepositUpload(
      xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'Month of TDS'], [depAug, '', 'ABCDE1234F', 1000, `${Y}-07`]]),
    );
    expect(rows[0]).toMatchObject({ forPeriod: `${Y}-08`, forPeriodExplicit: false });
    expect(result.warnings?.[0].message).toMatch(/"Month of TDS" looks like a month column but was not recognised/);
  });

  it('a month more than 12 months before the deposit → row error; exactly 12 months is allowed', () => {
    const d = ymd(Y, 8, 20);
    const thirteen = `${Y - 1}-07`;
    const twelve = `${Y - 1}-08`;
    const { rows, result } = parseDepositUpload(
      xlsxAb([['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'TDS for month'], [iso(d), '', 'ABCDE1234F', 1000, thirteen], [iso(d), '', 'ABCDE1234F', 1000, twelve]]),
    );
    expect(result.errors).toEqual([expect.objectContaining({ row: 2, message: expect.stringMatching(/more than 12 months before/) })]);
    expect(rows.map((r) => r.forPeriod)).toEqual([twelve]);
  });

  it('an explicit month in a DIFFERENT FY than the default → allowed with a preview warning; same FY → no warning', () => {
    const { rows, result } = parseDepositUpload(
      xlsxAb([
        ['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'TDS for month'],
        [iso(ymd(Y + 1, 4, 7)), '', 'ABCDE1234F', 1000, APRIL_NEXT], // default March (FY Y) → given April (FY Y+1)
        [depAug, '', 'ABCDE1234F', 1000, `${Y}-07`], // same FY
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toMatchObject({ row: 2 });
    expect(result.warnings![0].message).toContain(`FY ${NEXT_FY}, not FY ${FY}`);
  });
});

describe('TdsService.uploadDeposit — cross-upload duplicates (any earlier file / batch)', () => {
  let service: TdsService;
  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
        // D6: the 194R report reads the client's CURRENT methodology (default policy = GROSS_UP).
        { provide: TenantSettingsService, useValue: mockTdsTenantSettings },
      ],
    }).compile();
    service = module.get(TdsService);
    for (const m of Object.values(mockPrisma)) m.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.createMany.mockResolvedValue({ count: 0 });
  });

  const header = ['Date', 'Outlet Code', 'PAN', 'Amount (₹)', 'TDS for month'];
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const D = ymd(Y, 9, 15);
  const stored = (over: Partial<Record<string, unknown>> = {}) => ({
    clientId: CLIENT,
    panNumber: 'ABCDE1234F',
    depositDate: D,
    amountPaise: 100_000n,
    outletCode: null,
    forPeriod: `${Y}-09`,
    ...over,
  });

  it('same deposit already stored by ANOTHER file (same month) → skipped on preview AND apply; nothing inserted', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored()]);
    const ab = xlsxAb([header, [iso(D), '', 'abcde1234f', 1000, '']]);
    const preview = await service.uploadDeposit('194R', CLIENT, 'u1', multer(ab), false);
    expect(preview).toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
    expect(preview.errors[0].message).toMatch(/duplicate entry \(this deposit was already uploaded\)/);

    const applied = await service.uploadDeposit('194R', CLIENT, 'u1', multer(ab), true);
    expect(applied.skipped).toBe(1);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
    const where = mockPrisma.tdsDeposit.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ section: 'SEC_194R', clientId: CLIENT, panNumber: { in: ['ABCDE1234F'] } });
    expect(where).not.toHaveProperty('uploadBatchId'); // not limited to this file's batch
  });

  it('a stored copy with NO forPeriod (older build) still matches via the default rule', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored({ forPeriod: null })]);
    const res = await service.uploadDeposit('194R', CLIENT, 'u1', multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1000, '']])), true);
    expect(res.skipped).toBe(1);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });

  it('same deposit, only the TDS for month differs → conflict row error, not inserted', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored()]);
    const res = await service.uploadDeposit(
      '194R', CLIENT, 'u1', multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1000, `${Y}-08`]])), true,
    );
    expect(res).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.errors[0].message).toContain(`already uploaded with TDS for month ${formatForPeriod(`${Y}-09`)}`);
    expect(mockPrisma.tdsDeposit.createMany).not.toHaveBeenCalled();
  });

  it('a different amount / date / outlet is a different deposit → inserted', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored()]);
    const res = await service.uploadDeposit(
      '194R', CLIENT, 'u1',
      multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1001, ''], [iso(ymd(Y, 9, 16)), '', 'ABCDE1234F', 1000, ''], [iso(D), 'OUT9', 'ABCDE1234F', 1000, '']])),
      true,
    );
    expect(res).toMatchObject({ succeeded: 3, skipped: 0, failed: 0 });
    expect(mockPrisma.tdsDeposit.createMany.mock.calls[0][0].data).toHaveLength(3);
  });

  it('matching is one-to-one: 1 stored copy + 2 identical rows in the file → 1 skipped, 1 inserted', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored()]);
    const res = await service.uploadDeposit(
      '194R', CLIENT, 'u1', multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1000, ''], [iso(D), '', 'ABCDE1234F', 1000, '']])), true,
    );
    expect(res).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(mockPrisma.tdsDeposit.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('two identical rows in ONE file (nothing stored) → the second is reported as a duplicate of the first', async () => {
    const res = await service.uploadDeposit(
      '194R', CLIENT, 'u1', multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1000, ''], [iso(D), '', 'ABCDE1234F', 1000, '']])), true,
    );
    expect(res).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(res.errors[0].message).toMatch(/Row 3: skipped — duplicate entry \(same as row 2 of this file\)/);
  });

  it('194C: platform-wide query (no clientId filter); a stored platform PAN deposit is detected', async () => {
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([stored({ clientId: null })]);
    const res = await service.uploadDeposit('194C', null, 'u1', multer(xlsxAb([header, [iso(D), '', 'ABCDE1234F', 1000, '']])), true);
    expect(res.skipped).toBe(1);
    expect(mockPrisma.tdsDeposit.findMany.mock.calls[0][0].where).not.toHaveProperty('clientId');
  });
});
