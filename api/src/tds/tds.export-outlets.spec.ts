/**
 * 194R Excel export — Outlet Code / Outlet Name / Outlet Type on EVERY row (owner-approved
 * 2026-11-13, DISPLAY ONLY). A row shows the outlets that CONTRIBUTED to that deductee's FY base:
 * paid CreditPayoutEntry rows (incl. counted VENDOR_IMPORT incentive payouts) and off-platform
 * entries carrying an Outlet Code. A PAN row with none falls back to the outlets of the tenant's
 * NON-PARENT partners holding that PAN. No amount / row / Summary total changes.
 *
 * Runs the REAL compute194R against an emulating Prisma mock (no compute spy).
 * Run: npx jest src/tds/tds.export-outlets.spec.ts
 */
import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService, ContributingOutlets194R } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY } from './tds.helpers';

const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };

const CLIENT = 'bajaj';
// FY derived from "now" (never a hard-coded future date).
const now = new Date();
const fyStartYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const FY = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
const PERIOD = `${fyStartYear}-07`;
const IN_FY = new Date(Date.UTC(fyStartYear, 6, 15));

interface OutletFx { outletCode: string; name: string; type: string | null; partnerId: string | null; clientId?: string }
interface PartnerFx { id: string; panNumber: string | null; isParent: boolean; ownerName: string; clientId?: string }

let outlets: OutletFx[] = [];
let partners: PartnerFx[] = [];
let regularEntries: unknown[] = [];
let importedEntries: unknown[] = [];
let offPlatform: unknown[] = [];
let deposits: unknown[] = [];

let seq = 0;
const entry = (outletId: string, amountPaise: bigint, fieldId = 'f1') => ({
  id: `e${++seq}`, amountPaise, fieldId, outletId, tdsSection: null, period: PERIOD,
});

const inList = (cond: any, v: unknown) => !cond?.in || cond.in.includes(v);

const mockPrisma = {
  programSetting: { findUnique: jest.fn() },
  creditField: { findMany: jest.fn().mockResolvedValue([]) },
  creditPayoutEntry: {
    findMany: jest.fn(async (args: { where: Record<string, any> }) =>
      args.where.batch?.sourceKind === 'VENDOR_IMPORT' ? importedEntries : args.where.paidAt ? regularEntries : []),
  },
  outlet: {
    // Emulates clientId (scalar | {in}), outletCode {in}, partnerId {in}, OR[{outletCode:{equals, insensitive}}].
    findMany: jest.fn(async (args: { where: Record<string, any> }) => {
      const w = args.where;
      return outlets
        .map((o) => ({ ...o, clientId: o.clientId ?? CLIENT }))
        .filter((o) => {
          if (typeof w.clientId === 'string' && o.clientId !== w.clientId) return false;
          if (!inList(w.clientId, o.clientId)) return false;
          if (!inList(w.outletCode, o.outletCode)) return false;
          if (!inList(w.partnerId, o.partnerId)) return false;
          if (Array.isArray(w.OR)) {
            if (!w.OR.some((c: any) => String(c.outletCode?.equals ?? '').toUpperCase() === o.outletCode.toUpperCase())) return false;
          }
          return true;
        })
        .map((o) => ({
          outletCode: o.outletCode,
          name: o.name,
          partnerId: o.partnerId,
          clientId: o.clientId,
          outletType: o.type === null ? null : { name: o.type },
        }));
    }),
  },
  channelPartner: {
    findMany: jest.fn(async (args: { where: Record<string, any> }) => {
      const w = args.where;
      return partners
        .map((p) => ({ ...p, clientId: p.clientId ?? CLIENT }))
        .filter((p) => {
          if (!inList(w.id, p.id)) return false;
          if (w.isParent === false && p.isParent) return false;
          if (typeof w.clientId === 'string' && p.clientId !== w.clientId) return false;
          if (w.panNumber?.in && !w.panNumber.in.includes(p.panNumber)) return false;
          return true;
        })
        .map((p) => ({ ...p, businessName: `${p.ownerName} Stores`, entityType: 'INDIVIDUAL' }));
    }),
  },
  redemptionOrder: { findMany: jest.fn().mockResolvedValue([]) },
  tdsOffPlatformEntry: { findMany: jest.fn(async () => offPlatform) },
  tdsDeposit: { findMany: jest.fn(async () => deposits) },
};

function parseSheet(buffer: Buffer, idx = 0) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[idx]], { defval: '' });
}
function headers(buffer: Buffer): string[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  return (aoa[0] ?? []).map(String);
}

/** The full fixture: every outlet-column case in ONE tenant/FY. */
function fullFixture() {
  partners = [
    { id: 'pA', panNumber: 'AAAAA1111A', isParent: false, ownerName: 'Asha' },
    { id: 'pB', panNumber: 'BBBBB2222B', isParent: false, ownerName: 'Bala' },
    { id: 'pC1', panNumber: 'CCCCC3333C', isParent: false, ownerName: 'Chetan' },
    { id: 'pCP', panNumber: 'CCCCC3333C', isParent: true, ownerName: 'Chetan Group' }, // parent shares the PAN
    { id: 'pD', panNumber: 'DDDDD4444D', isParent: false, ownerName: 'Devi' },
    { id: 'pN', panNumber: null, isParent: false, ownerName: 'Nita' },
  ];
  outlets = [
    { outletCode: 'OA2', name: 'Alpha Two', type: 'Wholesaler', partnerId: 'pA' },
    { outletCode: 'OA1', name: 'Alpha One', type: 'SSS', partnerId: 'pA' },
    { outletCode: 'OA3', name: 'Alpha Three', type: 'SSS', partnerId: 'pA' }, // owned, paid nothing this FY
    { outletCode: 'OB1', name: '=HYPERLINK("http://evil")', type: null, partnerId: 'pB' }, // no type
    { outletCode: 'OC1', name: 'Gamma', type: 'SSS TOT', partnerId: 'pC1' },
    { outletCode: 'OCP', name: 'Group Parent Outlet', type: 'SSS', partnerId: 'pCP' }, // must NOT be used
    { outletCode: 'OD1', name: 'Delta One', type: 'Wholesaler', partnerId: 'pD' },
    { outletCode: 'OD2', name: 'Delta Two', type: 'Wholesaler', partnerId: 'pD' }, // owned, not contributing
    { outletCode: 'ON1', name: 'Nita Store', type: 'SSS', partnerId: 'pN' },
  ];
  regularEntries = [
    entry('OA2', 1_500_000n), entry('OA1', 600_000n), // A: two contributing outlets → ₹21,000
    entry('OB1', 2_500_000n),                           // B: ₹25,000
    entry('ON1', 2_500_000n),                           // no-PAN deductee N: ₹25,000
  ];
  offPlatform = [
    { panNumber: 'CCCCC3333C', amountPaise: 3_000_000n, outletCode: null },  // PAN-only → fallback
    { panNumber: 'DDDDD4444D', amountPaise: 2_100_000n, outletCode: 'od1' }, // PAN + code (any case)
    { panNumber: '__NO_PAN__', amountPaise: 100_000n, outletCode: null },    // unattributed bucket
  ];
  deposits = [
    { panNumber: 'AAAAA1111A', amountPaise: 100_000n, outletCode: null, clientId: CLIENT, forPeriod: PERIOD, depositDate: IN_FY },
    { panNumber: '__NO_PAN__', amountPaise: 50_000n, outletCode: null, clientId: CLIENT, forPeriod: PERIOD, depositDate: IN_FY },
  ];
}

describe('TdsService — export194R outlet columns', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    seq = 0;
    outlets = []; partners = []; regularEntries = []; importedEntries = []; offPlatform = []; deposits = [];
    mockPrisma.programSetting.findUnique.mockResolvedValue(null); // imported payouts OFF
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
      ],
    }).compile();
    service = module.get(TdsService);
  });

  const byPan = (rows: Record<string, unknown>[], pan: string) => rows.find((r) => r.PAN === pan)!;

  it('column order: S.No · Deductee Name · PAN · Outlet Code · Outlet Name · Outlet Type · Section · … · FY', async () => {
    fullFixture();
    const { buffer } = await service.export194R(CLIENT, FY);
    expect(headers(buffer)).toEqual([
      'S.No', 'Deductee Name', 'PAN', 'Outlet Code', 'Outlet Name', 'Outlet Type', 'Section',
      'Amount Paid (₹)', 'TDS Rate %', 'TDS Amount (₹)', 'Already Deposited (₹)',
      'Deposits — TDS for Month(s)', 'Outstanding (₹)', 'FY',
    ]);
  });

  it('PAN row whose two outlets both paid → both codes sorted, names/types aligned; an owned outlet that paid nothing is NOT shown', async () => {
    fullFixture();
    const rows = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    const a = byPan(rows, 'AAAAA1111A');
    expect(a['Outlet Code']).toBe('OA1, OA2');
    expect(a['Outlet Name']).toBe('Alpha One, Alpha Two');
    expect(a['Outlet Type']).toBe('SSS, Wholesaler');
    expect(String(a['Outlet Code'])).not.toContain('OA3');
  });

  it('PAN row with one contributing outlet → code, name and type filled', async () => {
    partners = [{ id: 'p1', panNumber: 'PPPPP1234P', isParent: false, ownerName: 'Prem' }];
    outlets = [{ outletCode: 'P1', name: 'Prem Traders', type: 'SSS', partnerId: 'p1' }];
    regularEntries = [entry('P1', 2_100_000n)];
    const [row] = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(row).toMatchObject({ PAN: 'PPPPP1234P', 'Outlet Code': 'P1', 'Outlet Name': 'Prem Traders', 'Outlet Type': 'SSS' });
  });

  it('off-platform entry with an Outlet Code (any case) contributes ONLY that outlet', async () => {
    fullFixture();
    const d = byPan(parseSheet((await service.export194R(CLIENT, FY)).buffer), 'DDDDD4444D');
    expect(d['Outlet Code']).toBe('OD1');
    expect(d['Outlet Name']).toBe('Delta One');
    expect(d['Outlet Type']).toBe('Wholesaler');
  });

  it('off-platform PAN-only entry → falls back to the PAN\'s NON-PARENT partners\' outlets (the parent\'s is never used)', async () => {
    fullFixture();
    const rows = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    const c = byPan(rows, 'CCCCC3333C');
    expect(c['Outlet Code']).toBe('OC1');
    expect(c['Outlet Name']).toBe('Gamma');
    expect(c['Outlet Type']).toBe('SSS TOT');
    // The partner lookup feeding the fallback is tenant-scoped and excludes parents.
    const panLookup = mockPrisma.channelPartner.findMany.mock.calls
      .map((c) => c[0].where)
      .find((w: any) => w.panNumber?.in?.includes('CCCCC3333C'));
    expect(panLookup).toMatchObject({ clientId: CLIENT, isParent: false });
  });

  it('PAN row with no contributing outlet and no partner on file → blank outlet cells', async () => {
    offPlatform = [{ panNumber: 'ZZZZZ9999Z', amountPaise: 2_100_000n, outletCode: null }];
    const [row] = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(row).toMatchObject({ PAN: 'ZZZZZ9999Z', 'Outlet Code': '', 'Outlet Name': '', 'Outlet Type': '' });
  });

  it('outlet type blank when the outlet has no type; cellSafe neutralises a formula-like outlet name', async () => {
    fullFixture();
    const b = byPan(parseSheet((await service.export194R(CLIENT, FY)).buffer), 'BBBBB2222B');
    expect(b['Outlet Code']).toBe('OB1');
    expect(b['Outlet Type']).toBe('');
    expect(b['Outlet Name']).toBe(`'=HYPERLINK("http://evil")`);
  });

  it('per-deductee no-PAN row keeps its outlet codes (today\'s behaviour, now with name/type); unattributed + "Earlier" rows are blank', async () => {
    fullFixture();
    const rows = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    const n = rows.find((r) => r['Deductee Name'] === 'Nita (NO PAN ON FILE)')!;
    expect(n).toMatchObject({ PAN: '', 'Outlet Code': 'ON1', 'Outlet Name': 'Nita Store', 'Outlet Type': 'SSS' });
    const bare = rows.find((r) => r['Deductee Name'] === 'NO PAN ON FILE')!;
    expect(bare).toMatchObject({ 'Outlet Code': '', 'Outlet Name': '', 'Outlet Type': '' });
    const earlier = rows.find((r) => r['Deductee Name'] === 'Earlier no-PAN deposits (not linked to a partner)')!;
    expect(earlier).toMatchObject({ 'Outlet Code': '', 'Outlet Name': '', 'Outlet Type': '' });
  });

  it('a deposit adds no outlet: a deposit-only PAN row falls back to its holder\'s outlets', async () => {
    partners = [{ id: 'pQ', panNumber: 'QQQQQ1234Q', isParent: false, ownerName: 'Q' }];
    outlets = [
      { outletCode: 'OQ1', name: 'Q One', type: 'SSS', partnerId: 'pQ' },
      { outletCode: 'XX9', name: 'Other', type: 'SSS', partnerId: null },
    ];
    deposits = [{ panNumber: 'QQQQQ1234Q', amountPaise: 10_000n, outletCode: 'XX9', clientId: CLIENT, forPeriod: PERIOD, depositDate: IN_FY }];
    const sink: ContributingOutlets194R = new Map();
    await service.compute194R(CLIENT, FY, null, sink);
    expect(sink.size).toBe(0);
    const [row] = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(row['Outlet Code']).toBe('OQ1');
  });

  describe('imported (VENDOR_IMPORT) incentive payouts', () => {
    const importedFixture = () => {
      partners = [{ id: 'pE', panNumber: 'EEEEE5555E', isParent: false, ownerName: 'Esha' }];
      outlets = [
        { outletCode: 'OE1', name: 'Esha One', type: 'Wholesaler', partnerId: 'pE' },
        { outletCode: 'OE2', name: 'Esha Two', type: 'SSS', partnerId: 'pE' },
      ];
      regularEntries = [entry('OE2', 100_000n)];
      importedEntries = [entry('OE1', 2_200_000n, 'historical-incentive-payout')];
    };

    it('countFrom ON → the imported entry\'s outlet contributes', async () => {
      importedFixture();
      mockPrisma.programSetting.findUnique.mockResolvedValue({ settingValue: { countFrom: `${fyStartYear}-04-01` } });
      const [row] = parseSheet((await service.export194R(CLIENT, FY)).buffer);
      expect(row).toMatchObject({ PAN: 'EEEEE5555E', 'Outlet Code': 'OE1, OE2', 'Outlet Name': 'Esha One, Esha Two', 'Outlet Type': 'Wholesaler, SSS' });
      expect(row['Amount Paid (₹)']).toBe(23000);
    });

    it('countFrom OFF → the imported entry does not contribute (only the regular payout\'s outlet)', async () => {
      importedFixture();
      const [row] = parseSheet((await service.export194R(CLIENT, FY)).buffer);
      expect(row).toMatchObject({ PAN: 'EEEEE5555E', 'Outlet Code': 'OE2', 'Outlet Name': 'Esha Two', 'Outlet Type': 'SSS' });
      expect(row['Amount Paid (₹)']).toBe(1000);
    });

    it('countFrom OFF and the deductee was paid ONLY imported payouts → no row at all', async () => {
      importedFixture();
      regularEntries = [];
      const rows = parseSheet((await service.export194R(CLIENT, FY)).buffer);
      expect(rows).toHaveLength(0);
    });
  });

  it('every numeric cell + the Summary sheet are unchanged (explicit values) and the rows are identical with or without the outlet sink', async () => {
    fullFixture();
    const plain = await service.compute194R(CLIENT, FY, null);
    const sink: ContributingOutlets194R = new Map();
    const withSink = await service.compute194R(CLIENT, FY, null, sink);
    expect(withSink).toEqual(plain);
    expect(Object.keys(withSink[0]).some((k) => /outlet/i.test(k))).toBe(false);
    // report194R (on-screen report / finance dashboard / liability) is unaffected too.
    const report = await service.report194R(CLIENT, FY);
    expect(report.rows).toEqual(plain);

    const { buffer } = await service.export194R(CLIENT, FY);
    const rows = parseSheet(buffer);
    expect(rows).toHaveLength(7);
    const num = (r: Record<string, unknown>) => [
      r['Amount Paid (₹)'], r['TDS Rate %'], r['TDS Amount (₹)'], r['Already Deposited (₹)'], r['Outstanding (₹)'],
    ];
    expect(num(byPan(rows, 'AAAAA1111A'))).toEqual([21000, 10, 2333, 1000, 1333]);
    expect(num(byPan(rows, 'BBBBB2222B'))).toEqual([25000, 10, 2778, 0, 2778]);
    expect(num(byPan(rows, 'CCCCC3333C'))).toEqual([30000, 10, 3333, 0, 3333]);
    expect(num(byPan(rows, 'DDDDD4444D'))).toEqual([21000, 10, 2333, 0, 2333]);
    expect(num(rows.find((r) => r['Deductee Name'] === 'Nita (NO PAN ON FILE)')!)).toEqual([25000, 20, 6250, 0, 6250]);
    expect(num(rows.find((r) => r['Deductee Name'] === 'NO PAN ON FILE')!)).toEqual([1000, 20, 0, 0, 0]);
    expect(num(rows.find((r) => r['Deductee Name'] === 'Earlier no-PAN deposits (not linked to a partner)')!)).toEqual([0, 20, 0, 500, -500]);
    // Row order unchanged: same order as compute194R.
    expect(rows.map((r) => r['S.No'])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.map((r) => (r.PAN as string) || r['Deductee Name'])).toEqual(
      plain.map((r) => (r.panNumber.startsWith('__NO_PAN__') ? (r.unlinkedNoPanDeposit ? 'Earlier no-PAN deposits (not linked to a partner)' : r.noPanDeductee ? `${r.noPanDeductee.name} (NO PAN ON FILE)` : 'NO PAN ON FILE') : r.panNumber)),
    );

    const summary = Object.fromEntries(parseSheet(buffer, 1).map((r) => [r.Field, r.Value]));
    expect(summary).toEqual({
      'Total Deductees': 7,
      'Total Amount Paid (₹)': 123000,
      'Total TDS Amount (₹)': 17027,
      'Total Already Deposited (₹)': 1500,
      'Total Outstanding (₹)': 15527,
      FY,
    });
  });

  it('batched lookups: no N+1 — at most 3 extra outlet queries regardless of row count', async () => {
    partners = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, panNumber: `PAN${String(i).padStart(5, '0')}X`, isParent: false, ownerName: `O${i}` }));
    outlets = partners.map((p, i) => ({ outletCode: `C${i}`, name: `N${i}`, type: 'SSS', partnerId: p.id }));
    regularEntries = outlets.slice(0, 25).map((o) => entry(o.outletCode, 2_100_000n));
    offPlatform = partners.slice(25).map((p) => ({ panNumber: p.panNumber, amountPaise: 2_100_000n, outletCode: null }));
    await service.compute194R(CLIENT, FY, null);
    const computeCalls = mockPrisma.outlet.findMany.mock.calls.length;
    mockPrisma.outlet.findMany.mockClear();
    const rows = parseSheet((await service.export194R(CLIENT, FY)).buffer);
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r['Outlet Code'])).toBe(true);
    expect(mockPrisma.outlet.findMany.mock.calls.length).toBeLessThanOrEqual(computeCalls + 3);
    for (const [args] of mockPrisma.outlet.findMany.mock.calls) {
      const w = (args as { where: Record<string, unknown> }).where;
      expect(w.clientId).toBe(CLIENT); // always tenant-scoped
    }
  });
});
