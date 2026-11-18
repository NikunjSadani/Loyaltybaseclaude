/**
 * Per-deductee no-PAN TDS (owner-approved 2026-11-12): a partner with no PAN is its OWN deductee —
 * the FY threshold and the no-PAN 20/80 gross-up apply PER RECIPIENT, never to a pooled
 * '__NO_PAN__' bucket. Covers compute194R / compute194C / deposits / recovery attribution / exports,
 * and that a tenant with no no-PAN deductee is unchanged (no extra query, no extra column).
 *
 * Run: npx jest src/tds/tds.no-pan-deductee.spec.ts
 */
import * as XLSX from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY } from './tds.helpers';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
const mockTdsTenantSettings = {
  resolveTdsPolicy: jest.fn().mockResolvedValue({ section: 'SEC_194C', methodology: 'GROSS_UP' }),
};

const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };

const mockPrisma = {
  // tdsImportedPayouts setting read (fail-closed): no row → OFF.
  programSetting: { findUnique: jest.fn(), findMany: jest.fn() }, // findMany: the loops below reset every model's findMany
  creditPayoutEntry: { findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  tdsOffPlatformEntry: { findMany: jest.fn() },
  tdsDeposit: { findMany: jest.fn() },
  tdsDeductionEntry: { findMany: jest.fn() },
  tdsRecoveryEntry: { findMany: jest.fn() },
};

const CLIENT = 'bajaj';
// FY derived from "now" (never a hard-coded future date); entries are dated inside it.
const now = new Date();
const fyStartYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const FY = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
const IN_FY = new Date(Date.UTC(fyStartYear, 6, 15)); // 15 Jul of the FY
const PERIOD = `${fyStartYear}-07`;

let seq = 0;
const entry = (outletId: string, fieldId: string, amountPaise: bigint, clientId = CLIENT) => ({
  id: `e${++seq}`,
  amountPaise,
  fieldId,
  outletId,
  paidAt: IN_FY,
  period: PERIOD,
  status: 'PAID',
  clientId,
  tdsSection: null,
  tdsMethodology: null,
});

interface PartnerFx { id: string; pan: string | null; owner: string; outlets: string[]; entityType?: string }

/** Wire outlet/channelPartner mocks so each query shape gets the matching slice of `partners`. */
function wire(
  partners: PartnerFx[],
  ownerless: Array<{ outletCode: string; name: string }> = [],
  otherTenantOutlets: Array<{ outletCode: string; clientId: string; partnerId: string | null }> = [],
) {
  const outletRows = [
    ...partners.flatMap((p) => p.outlets.map((o) => ({ outletCode: o, partnerId: p.id, clientId: CLIENT, name: `${o}-name` }))),
    ...ownerless.map((o) => ({ outletCode: o.outletCode, partnerId: null, clientId: CLIENT, name: o.name })),
    ...otherTenantOutlets.map((o) => ({ ...o, name: `${o.outletCode}-other` })),
  ];
  // Emulates the Prisma filters the service uses: clientId (scalar | {in}), outletCode {in},
  // partnerId {in}, and OR[{ outletCode: { equals, mode: 'insensitive' } }].
  mockPrisma.outlet.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    return outletRows.filter((o) => {
      if (typeof w.clientId === 'string' && o.clientId !== w.clientId) return false;
      if (w.clientId?.in && !w.clientId.in.includes(o.clientId)) return false;
      if (w.partnerId?.in && !w.partnerId.in.includes(o.partnerId)) return false;
      if (w.outletCode?.in && !w.outletCode.in.includes(o.outletCode)) return false;
      if (Array.isArray(w.OR)) {
        const hit = w.OR.some((c: any) => String(c.outletCode?.equals ?? '').toUpperCase() === o.outletCode.toUpperCase());
        if (!hit) return false;
      }
      return true;
    });
  });
  mockPrisma.channelPartner.findMany.mockImplementation(async (args: { where: Record<string, any> }) =>
    partners
      .filter((p) => !args.where.id?.in || args.where.id.in.includes(p.id))
      .map((p) => ({
        id: p.id,
        clientId: CLIENT,
        panNumber: p.pan,
        entityType: p.entityType ?? 'INDIVIDUAL',
        ownerName: p.owner,
        businessName: `${p.owner} Stores`,
      })),
  );
}

function parseSheet(buffer: Buffer, idx = 0) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[idx]]);
}
function headers(buffer: Buffer, idx = 0): string[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[idx]], { header: 1 });
  return (aoa[0] ?? []).map(String);
}

describe('TdsService — per-deductee no-PAN', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    seq = 0;
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
  });

  // ─── 194R ──────────────────────────────────────────────────────────────────

  it('194R: 10 no-PAN partners × ₹5,000 → 10 separate rows, each ₹0 liability (no pooled ₹50k crossing)', async () => {
    const partners: PartnerFx[] = Array.from({ length: 10 }, (_, i) => ({
      id: `cp${i}`, pan: null, owner: `Owner ${i}`, outlets: [`OUT${i}`],
    }));
    wire(partners);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(partners.map((p) => entry(p.outlets[0], 'f1', 500_000n)));

    const rows = await service.compute194R(CLIENT, FY);

    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.panNumber).toMatch(/^__NO_PAN__:cp\d$/);
      expect(r.baseFyTotalPaise).toBe(500_000n);
      expect(r.liabilityPaise).toBe(0n);
    }
    expect(rows.reduce((s, r) => s + r.liabilityPaise, 0n)).toBe(0n);
    const summary = await service.summary194R(CLIENT, FY);
    expect(summary.totalLiabilityPaise).toBe(0n);
    expect(summary.rowCount).toBe(10);
  });

  it('194R: one ₹25,000 + five ₹5,000 no-PAN partners → ONLY the ₹25k partner is liable (20/80)', async () => {
    const partners: PartnerFx[] = [
      { id: 'big', pan: null, owner: 'Big Owner', outlets: ['B1'] },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, pan: null, owner: `Small ${i}`, outlets: [`S${i}`] })),
    ];
    wire(partners);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
      entry('B1', 'f1', 2_500_000n),
      ...partners.slice(1).map((p) => entry(p.outlets[0], 'f1', 500_000n)),
    ]);

    const rows = await service.compute194R(CLIENT, FY);
    const big = rows.find((r) => r.panNumber === '__NO_PAN__:big')!;
    expect(big.liabilityPaise).toBe(625_000n); // 2,500,000 × 20 / 80
    expect(big.noPanDeductee).toEqual({ partnerId: 'big', clientId: CLIENT, name: 'Big Owner', outletCodes: ['B1'] });
    for (const r of rows.filter((x) => x.panNumber !== '__NO_PAN__:big')) expect(r.liabilityPaise).toBe(0n);
    expect(rows.reduce((s, r) => s + r.liabilityPaise, 0n)).toBe(625_000n);
    // threshold-met row sorts first
    expect(rows[0].panNumber).toBe('__NO_PAN__:big');
  });

  it('194R: a no-PAN partner\'s credit + DELIVERED redemption combine into ONE deductee row', async () => {
    wire([{ id: 'cpX', pan: null, owner: 'X', outlets: ['OX'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OX', 'f1', 1_000_000n)]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 1_500_000n, partner: { id: 'cpX', panNumber: null } },
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].panNumber).toBe('__NO_PAN__:cpX');
    expect(rows[0].baseFyTotalPaise).toBe(2_500_000n);
    expect(rows[0].liabilityPaise).toBe(625_000n);
    // the redemption query now selects the partner id (needed for the per-deductee key)
    expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].select.partner.select).toEqual({ id: true, panNumber: true });
  });

  it('194R: PAN partners are unchanged alongside no-PAN deductees', async () => {
    wire([
      { id: 'pan1', pan: 'ABCDE1234F', owner: 'Pan Owner', outlets: ['P1'] },
      { id: 'np1', pan: null, owner: 'No Pan', outlets: ['N1'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('P1', 'f1', 2_100_000n), entry('N1', 'f1', 500_000n)]);
    const rows = await service.compute194R(CLIENT, FY);
    const pan = rows.find((r) => r.panNumber === 'ABCDE1234F')!;
    expect(pan).toMatchObject({
      panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 2_100_000n,
      liabilityPaise: 233_300n, depositedPaise: 0n, outstandingPaise: 233_300n,
    });
    expect(pan.noPanDeductee).toBeUndefined();
  });

  it('194R: a no-PAN deposit (lower-case Outlet Code) nets against THAT deductee; a legacy pooled one is its own "Earlier" row (outstanding −deposit); totals = Σ rows', async () => {
    wire([{ id: 'big', pan: null, owner: 'Big', outlets: ['B1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('B1', 'f1', 2_500_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: '__NO_PAN__', outletCode: 'b1', amountPaise: 600_000n }, // marker stored by the upload
      { panNumber: '__NO_PAN__', outletCode: null, amountPaise: 100_000n }, // legacy pooled deposit
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    const big = rows.find((r) => r.panNumber === '__NO_PAN__:big')!;
    expect(big.depositedPaise).toBe(600_000n);
    expect(big.outstandingPaise).toBe(25_000n);
    const earlier = rows.find((r) => r.unlinkedNoPanDeposit)!;
    expect(earlier).toMatchObject({
      panNumber: '__NO_PAN__:unlinked-deposits', baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 100_000n, outstandingPaise: -100_000n,
    });
    expect(earlier.noPanDeductee).toBeUndefined();
    // totals: outstanding = liability − every deposit (the pooled deposit nets against no-PAN liability)
    const summary = await service.summary194R(CLIENT, FY);
    expect(summary.totalLiabilityPaise).toBe(625_000n);
    expect(summary.totalDepositedPaise).toBe(700_000n);
    expect(summary.totalOutstandingPaise).toBe(625_000n - 700_000n);
  });

  it('194R (R3-2): an unlinked no-PAN deposit ALWAYS shows, even on a PAN-only tenant; totals = Σ rows', async () => {
    wire([{ id: 'cp1', pan: 'ABCDE1234F', owner: 'A', outlets: ['O1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('O1', 'f1', 2_100_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: null, amountPaise: 100_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows.find((r) => r.unlinkedNoPanDeposit)).toMatchObject({ depositedPaise: 100_000n, outstandingPaise: -100_000n });
    const sum = await service.summary194R(CLIENT, FY);
    expect(sum.totalDepositedPaise).toBe(rows.reduce((x, r) => x + r.depositedPaise, 0n));
    expect(sum.totalOutstandingPaise).toBe(rows.reduce((x, r) => x + r.outstandingPaise, 0n));
    expect(sum.totalOutstandingPaise).toBe(sum.totalLiabilityPaise - sum.totalDepositedPaise);
    expect(sum.rowCount).toBe(2);
  });

  it('194R: an identity-less no-PAN BASE (no outlet code) stays a bare row; an unlinked deposit is its own row', async () => {
    wire([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: null, amountPaise: 2_500_000n }]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '', outletCode: null, amountPaise: 100_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toMatchObject([
      { panNumber: '__NO_PAN__', fyLabel: FY, baseFyTotalPaise: 2_500_000n, liabilityPaise: 625_000n, depositedPaise: 0n, outstandingPaise: 625_000n },
      { panNumber: '__NO_PAN__:unlinked-deposits', fyLabel: FY, baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 100_000n, outstandingPaise: -100_000n, unlinkedNoPanDeposit: true },
    ]);
  });

  it('194R (R3-3): a no-PAN off-platform entry whose outlet owner HAS a PAN counts under that PAN (deposit too)', async () => {
    wire([{ id: 'cpP', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OP', 'f1', 1_000_000n)]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: 'op', amountPaise: 1_500_000n }]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: 'OP', amountPaise: 50_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toMatchObject([
      { panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 2_500_000n, liabilityPaise: 277_800n, depositedPaise: 50_000n, outstandingPaise: 227_800n },
    ]);
  });

  it('194R (item 9): a no-PAN off-platform entry is attributed via its Outlet Code (case-insensitive) to the partner\'s own deductee', async () => {
    wire([{ id: 'cpX', pan: null, owner: 'X', outlets: ['OX'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OX', 'f1', 1_000_000n)]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([
      { panNumber: '__NO_PAN__', outletCode: 'ox', amountPaise: 1_500_000n },
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].panNumber).toBe('__NO_PAN__:cpX');
    expect(rows[0].baseFyTotalPaise).toBe(2_500_000n);
    expect(rows[0].liabilityPaise).toBe(625_000n);
  });

  it('194R (R3-4): STORED partner PANs are never reinterpreted — "NA"/"PANINVALID" stay as given; only blank / __NO_PAN__ mean no PAN', async () => {
    wire([
      { id: 'n1', pan: 'NA', owner: 'N1', outlets: ['A1'] },
      { id: 'n2', pan: 'PANINVALID', owner: 'N2', outlets: ['A2'] },
      { id: 'n3', pan: '__NO_PAN__', owner: 'N3', outlets: ['A3'] },
      { id: 'n4', pan: '  ', owner: 'N4', outlets: ['A4'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(['A1', 'A2', 'A3', 'A4'].map((o) => entry(o, 'f1', 500_000n)));
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows.map((r) => r.panNumber).sort()).toEqual(['NA', 'PANINVALID', '__NO_PAN__:n3', '__NO_PAN__:n4']);
  });

  it('194R: Deoleo-style tenant (PAN partners only) — identical rows, no extra queries', async () => {
    wire([{ id: 'cp1', pan: 'ABCDE1234F', owner: 'A', outlets: ['O1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('O1', 'f1', 2_100_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 100_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toMatchObject([
      { panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 2_100_000n, liabilityPaise: 233_300n, depositedPaise: 100_000n, outstandingPaise: 133_300n },
    ]);
    expect(Object.keys(rows[0])).not.toContain('noPanDeductee');
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(1); // only the existing outlet→partner lookup
    expect(mockPrisma.channelPartner.findMany).toHaveBeenCalledTimes(1); // only the existing PAN lookup
  });

  it('export194R: one row per no-PAN deductee, name "(NO PAN ON FILE)", PAN blank, Outlet Code identifier, 20%', async () => {
    wire([
      { id: 'pan1', pan: 'ABCDE1234F', owner: 'Pan Owner', outlets: ['P1'] },
      { id: 'big', pan: null, owner: 'Big Owner', outlets: ['B1', 'B2'] },
      { id: 'small', pan: null, owner: 'Small Owner', outlets: ['S1'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
      entry('P1', 'f1', 2_100_000n), entry('B1', 'f1', 2_500_000n), entry('S1', 'f1', 500_000n),
    ]);
    const { buffer } = await service.export194R(CLIENT, FY);
    const h = headers(buffer);
    expect(h.slice(0, 4)).toEqual(['S.No', 'Deductee Name', 'PAN', 'Outlet Code']);
    const rows = parseSheet(buffer);
    const big = rows.find((r) => r['Deductee Name'] === 'Big Owner (NO PAN ON FILE)')!;
    expect(big.PAN).toBe(''); // blank cell
    expect(big['Outlet Code']).toBe('B1, B2');
    expect(big['TDS Rate %']).toBe(20);
    expect(big['TDS Amount (₹)']).toBe(6250);
    const small = rows.find((r) => r['Deductee Name'] === 'Small Owner (NO PAN ON FILE)')!;
    expect(small['TDS Amount (₹)']).toBe(0);
    const pan = rows.find((r) => r.PAN === 'ABCDE1234F')!;
    expect(pan['Deductee Name']).toBe('Pan Owner');
    // 2026-11-13: PAN rows carry their contributing outlet too (was blank before).
    expect(pan['Outlet Code']).toBe('P1');
    expect(pan['TDS Rate %']).toBe(10);
  });

  it('export194R: PAN-only tenant → Outlet Code / Name / Type columns are ALWAYS present (2026-11-13)', async () => {
    wire([{ id: 'cp1', pan: 'ABCDE1234F', owner: 'A', outlets: ['O1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('O1', 'f1', 2_100_000n)]);
    const { buffer } = await service.export194R(CLIENT, FY);
    expect(headers(buffer)).toEqual([
      'S.No', 'Deductee Name', 'PAN', 'Outlet Code', 'Outlet Name', 'Outlet Type', 'Section', 'Amount Paid (₹)',
      'Cash Benefits (₹)', 'Non-cash Benefits (₹)', 'Method', 'TDS Rate %',
      'Base Deducted from Retailer (₹)', 'Base Borne by Client (₹)', 'TDS — Deducted Part (₹)', 'TDS — Client-borne Part (₹)',
      'TDS Amount (₹)', 'Deducted from Payouts So Far (₹)', 'TDS Taken in Excess (₹)', 'Already Deposited (₹)', 'of which Imported Vendor TDS (₹)',
      'Deposits — TDS for Month(s)', 'Outstanding (₹)', 'Note', 'FY',
    ]);
    expect(parseSheet(buffer)[0]['Outlet Code']).toBe('O1');
  });

  // ─── 194C ──────────────────────────────────────────────────────────────────

  it('194C: two no-PAN partners each below the ₹1,00,000 FY threshold → ₹0 each (no pooled crossing)', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([
      { id: 'a', pan: null, owner: 'A', outlets: ['OA'] },
      { id: 'b', pan: null, owner: 'B', outlets: ['OB'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
      entry('OA', 'vis', 2_900_000n), entry('OA', 'vis', 2_900_000n), // ₹58k, max single ₹29k
      entry('OB', 'vis', 2_900_000n), entry('OB', 'vis', 2_900_000n),
    ]);
    const rows = await service.compute194C(FY);
    expect(rows.map((r) => r.panNumber).sort()).toEqual([`__NO_PAN__:outlet:${CLIENT}:OA`, `__NO_PAN__:outlet:${CLIENT}:OB`]);
    for (const r of rows) {
      expect(r.thresholdMet).toBe(false);
      expect(r.liabilityPaise).toBe(0n);
      expect(r.liabilityNoThresholdPaise).toBe(1_450_000n); // 5,800,000 × 20/80
    }
  });

  it('194C: a no-PAN recovery row (`__NO_PAN__:<outlet>` + clientId) lines up with that deductee\'s row', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'a', pan: null, owner: 'A', outlets: ['OA'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'vis', 12_000_000n)]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([
      { panNumber: '__NO_PAN__:OA', clientId: CLIENT, tenantSharePaise: 3_000_000n },
    ]);
    const rows = await service.compute194C(FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].panNumber).toBe(`__NO_PAN__:outlet:${CLIENT}:OA`);
    expect(rows[0].liabilityPaise).toBe(3_000_000n);
    expect(rows[0].recoveredPaise).toBe(3_000_000n);
    expect(rows[0].recoveryByTenant).toEqual([{ clientId: CLIENT, tenantSharePaise: 3_000_000n }]);
    expect(rows[0].noPanDeductee).toMatchObject({ partnerId: 'a', name: 'A', outletCodes: ['OA'] });
  });

  it('194C (item 8): one no-PAN partner with TWO outlets → two per-outlet rows, each tested on its own (credits-rail granularity)', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'a', pan: null, owner: 'A', outlets: ['OA1', 'OA2'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA1', 'vis', 6_000_000n), entry('OA2', 'vis', 6_000_000n)]);
    const rows = await service.compute194C(FY);
    expect(rows.map((r) => r.panNumber).sort()).toEqual([`__NO_PAN__:outlet:${CLIENT}:OA1`, `__NO_PAN__:outlet:${CLIENT}:OA2`]);
    // ₹60k each: single > ₹30k → met per outlet
    for (const r of rows) expect(r.thresholdMet).toBe(true);
  });

  it('194C (item 10): a clientId-null no-PAN deposit resolves by outlet code + that outlet\'s tenant; ambiguous codes stay unlinked', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'a', pan: null, owner: 'A', outlets: ['OA', 'DUP'] }], [], [{ outletCode: 'DUP', clientId: 'other', partnerId: null }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'vis', 12_000_000n), entry('DUP', 'vis', 12_000_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: '__NO_PAN__', outletCode: 'oa', clientId: null, amountPaise: 1_000_000n }, // unique → OA
      { panNumber: '__NO_PAN__', outletCode: 'DUP', clientId: null, amountPaise: 500_000n },  // 2 tenants → unlinked
      { panNumber: '__NO_PAN__', outletCode: 'DUP', clientId: 'other', amountPaise: 70_000n }, // tenant given → other:DUP (no base) → its own deposit-only row (fix D)
    ]);
    const rows = await service.compute194C(FY);
    const oa = rows.find((r) => r.panNumber === `__NO_PAN__:outlet:${CLIENT}:OA`)!;
    expect(oa.depositedPaise).toBe(1_000_000n);
    const dup = rows.find((r) => r.panNumber === `__NO_PAN__:outlet:${CLIENT}:DUP`)!;
    expect(dup.depositedPaise).toBe(0n);
    const earlier = rows.find((r) => r.unlinkedNoPanDeposit)!;
    expect(earlier).toMatchObject({ depositedPaise: 500_000n, outstandingPaise: -500_000n });
    const otherDup = rows.find((r) => r.panNumber === `__NO_PAN__:outlet:other:DUP`)!;
    expect(otherDup).toMatchObject({ baseFyTotalPaise: 0n, depositedPaise: 70_000n, outstandingPaise: -70_000n });
    expect(otherDup.unlinkedNoPanDeposit).toBeUndefined();
    const sum = await service.summary194C(FY);
    expect(sum.totalOutstandingPaise).toBe(sum.totalLiabilityPaise - sum.totalDepositedPaise - sum.totalWithheldPaise);
  });

  it('194C (R3-4): a WITHHELD-only no-PAN key keeps its own row (withheld never drops out)', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'p', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'], entityType: 'COMPANY' }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OP', 'vis', 12_000_000n)]);
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: '', tdsDeductedThisPaise: 40_000n }]);
    const rows = await service.compute194C(FY);
    expect(rows.find((r) => r.panNumber === '__NO_PAN__')).toMatchObject({ withheldPaise: 40_000n, outstandingPaise: -40_000n, liabilityPaise: 0n });
    const sum = await service.summary194C(FY);
    expect(sum.totalWithheldPaise).toBe(40_000n);
  });

  it('export194R: the "Earlier no-PAN deposits" row is labelled (outstanding −deposit) and the Summary = Σ rows', async () => {
    wire([{ id: 'big', pan: null, owner: 'Big', outlets: ['B1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('B1', 'f1', 2_500_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: null, amountPaise: 100_000n }]);
    const { buffer } = await service.export194R(CLIENT, FY);
    const rows = parseSheet(buffer);
    const earlier = rows.find((r) => r['Deductee Name'] === 'Earlier no-PAN deposits (not linked to a partner)')!;
    expect(earlier['Already Deposited (₹)']).toBe(1000);
    // Money cells are written as NUMBERS (the formula-injection guard only touches text cells), so a
    // negative outstanding is a real negative number — not the guarded text "'-1000.00".
    expect(earlier['Outstanding (₹)']).toBe(-1000);
    expect(typeof earlier['Outstanding (₹)']).toBe('number');
    const summary = parseSheet(buffer, 1);
    expect(summary.find((r) => r.Field === 'Total Outstanding (₹)')!.Value).toBe(5250); // 6250 − 1000
  });

  it('export194R (FA-3): text cells keep the formula-injection guard; money cells are numbers', async () => {
    wire([{ id: 'evil', pan: null, owner: '=WEBSERVICE("x")', outlets: ['E1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('E1', 'f1', 2_500_000n)]);
    const { buffer } = await service.export194R(CLIENT, FY);
    const row = parseSheet(buffer)[0];
    expect(String(row['Deductee Name']).startsWith("'=")).toBe(true);
    expect(row['Amount Paid (₹)']).toBe(25000);
    expect(row['TDS Amount (₹)']).toBe(6250);
  });

  it('194R (FA-2): a no-PAN-marker deposit attributed to an owner PAN with NO base this FY still gets a row (base 0, outstanding −deposit)', async () => {
    wire([
      { id: 'cpP', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'] },
      { id: 'cpQ', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'f1', 2_100_000n)]); // only Q has a base
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: 'op', amountPaise: 50_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows.find((r) => r.panNumber === 'ABCDE1234F')).toMatchObject({
      panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 50_000n, outstandingPaise: -50_000n,
    });
    const sum = await service.summary194R(CLIENT, FY);
    expect(sum.totalDepositedPaise).toBe(50_000n);
  });

  it('194C (FA-2): a no-PAN-marker deposit attributed to an owner PAN with NO base this FY still gets a row', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([
      { id: 'p', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'], entityType: 'COMPANY' },
      { id: 'q', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'], entityType: 'COMPANY' },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'vis', 12_000_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: '__NO_PAN__', outletCode: 'OP', clientId: CLIENT, amountPaise: 70_000n }]);
    const rows = await service.compute194C(FY);
    expect(rows.find((r) => r.panNumber === 'ABCDE1234F')).toMatchObject({
      baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 70_000n, outstandingPaise: -70_000n,
    });
    expect(rows.filter((r) => r.panNumber === 'ABCDE1234F')).toHaveLength(1);
  });

  it('194C (FA-4): recovery-only AND withheld-only on the bare `__NO_PAN__` key → ONE merged row, recovered counted once', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'a', pan: null, owner: 'A', outlets: ['OA'] }]); // a no-PAN row exists → recovery-only rows emitted
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'vis', 12_000_000n)]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([{ panNumber: '', clientId: CLIENT, tenantSharePaise: 25_000n }]);
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: '', tdsDeductedThisPaise: 40_000n }]);
    const rows = await service.compute194C(FY);
    const bare = rows.filter((r) => r.panNumber === '__NO_PAN__');
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ withheldPaise: 40_000n, recoveredPaise: 25_000n, outstandingPaise: -40_000n });
    const sum = await service.summary194C(FY);
    expect(sum.totalWithheldPaise).toBe(40_000n);
  });

  it('194C: PAN-only (Deoleo-style) → no noPanDeductee, no extra outlet/partner queries', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'p', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'], entityType: 'COMPANY' }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OP', 'vis', 12_000_000n)]);
    const rows = await service.compute194C(FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].panNumber).toBe('ABCDE1234F');
    expect(rows[0].liabilityPaise).toBe(244_900n);
    expect(Object.keys(rows[0])).not.toContain('noPanDeductee');
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.channelPartner.findMany).toHaveBeenCalledTimes(1);
    const { buffer } = await service.export194C(FY);
    expect(headers(buffer)).not.toContain('Outlet Code');
  });

  it('export194C: no-PAN deductee row carries name + Outlet Code, PAN blank, 20%', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'a', pan: null, owner: 'Asha', outlets: ['OA'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'vis', 12_000_000n)]);
    const { buffer } = await service.export194C(FY);
    const [row] = parseSheet(buffer);
    expect(row['Deductee Name']).toBe('Asha (NO PAN ON FILE)');
    expect(row.PAN).toBe('');
    expect(row['Outlet Code']).toBe('OA');
    expect(row['TDS Rate %']).toBe(20);
  });

  // ─── Deposit-only rows for ANY PAN (owner-approved 2026-11-12) ────────────────
  // A deposit made in the FY for a PAN with no payouts in that FY (e.g. March's TDS deposited in
  // April of the next FY) must appear as its own row and in the totals — for a direct PAN deposit
  // exactly as for a no-PAN-marker deposit attributed to an owner PAN.

  const sumRows = (rows: Array<{ baseFyTotalPaise: bigint; liabilityPaise: bigint; depositedPaise: bigint; outstandingPaise: bigint }>) => ({
    base: rows.reduce((t, r) => t + r.baseFyTotalPaise, 0n),
    liability: rows.reduce((t, r) => t + r.liabilityPaise, 0n),
    deposited: rows.reduce((t, r) => t + r.depositedPaise, 0n),
    outstanding: rows.reduce((t, r) => t + r.outstandingPaise, 0n),
  });

  it('194R DEP-1: a direct PAN deposit with NO payouts this FY → its own row (base 0, −deposit), PAN upper-cased; totals = Σ rows', async () => {
    wire([
      { id: 'cpP', pan: 'ABCDE1234F', owner: 'Prev FY', outlets: ['OP'] },
      { id: 'cpQ', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'f1', 2_100_000n)]); // only Q paid this FY
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: ' abcde1234f ', outletCode: null, amountPaise: 40_000n }, // lower-case, padded
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows.filter((r) => r.panNumber === 'ABCDE1234F')).toMatchObject([
      { panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 40_000n, outstandingPaise: -40_000n },
    ]);
    const sum = await service.summary194R(CLIENT, FY);
    const s = sumRows(rows);
    expect(sum.totalDepositedPaise).toBe(40_000n);
    expect(sum.totalDepositedPaise).toBe(s.deposited);
    expect(sum.totalBasePaise).toBe(s.base);
    expect(sum.totalLiabilityPaise).toBe(s.liability);
    expect(sum.totalOutstandingPaise).toBe(s.outstanding);
    expect(sum.rowCount).toBe(rows.length);

    // Export: the deposit-only row is present with numeric money cells.
    const { buffer } = await service.export194R(CLIENT, FY);
    const xr = parseSheet(buffer).find((r) => r.PAN === 'ABCDE1234F')!;
    expect(xr['Amount Paid (₹)']).toBe(0);
    expect(xr['TDS Amount (₹)']).toBe(0);
    expect(xr['Already Deposited (₹)']).toBe(400);
    expect(xr['Outstanding (₹)']).toBe(-400);
    const summary = parseSheet(buffer, 1);
    expect(summary.find((r) => r.Field === 'Total Already Deposited (₹)')!.Value).toBe(400);
  });

  it('194R DEP-2: a PAN with payouts AND a deposit (case differs) → ONE row; direct + marker deposits to a deposit-only PAN → ONE row, summed', async () => {
    wire([
      { id: 'cpQ', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'] },
      { id: 'cpP', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'f1', 2_100_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: 'qqqqq1234q', outletCode: null, amountPaise: 10_000n },
      { panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 20_000n },
      { panNumber: '__NO_PAN__', outletCode: 'op', amountPaise: 5_000n }, // owner P's PAN
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    const q = rows.filter((r) => r.panNumber === 'QQQQQ1234Q');
    expect(q).toHaveLength(1);
    expect(q[0].baseFyTotalPaise).toBe(2_100_000n);
    expect(q[0].depositedPaise).toBe(10_000n);
    expect(q[0].outstandingPaise).toBe(q[0].liabilityPaise - 10_000n);
    const p = rows.filter((r) => r.panNumber === 'ABCDE1234F');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ baseFyTotalPaise: 0n, depositedPaise: 25_000n, outstandingPaise: -25_000n });
    expect(rows).toHaveLength(2);
    expect((await service.summary194R(CLIENT, FY)).totalDepositedPaise).toBe(35_000n);
  });

  it('194R DEP-3 (Deoleo case): every deposit PAN has payouts → exactly the payee rows, no extra row', async () => {
    wire([
      { id: 'cpA', pan: 'AAAAA1111A', owner: 'A', outlets: ['OA'] },
      { id: 'cpB', pan: 'BBBBB2222B', owner: 'B', outlets: ['OB'] },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'f1', 2_100_000n), entry('OB', 'f1', 900_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'AAAAA1111A', outletCode: null, amountPaise: 50_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows.map((r) => [r.panNumber, r.baseFyTotalPaise, r.depositedPaise])).toEqual([
      ['AAAAA1111A', 2_100_000n, 50_000n],
      ['BBBBB2222B', 900_000n, 0n],
    ]);
    for (const r of rows) {
      expect(r.outstandingPaise).toBe(r.liabilityPaise - r.depositedPaise);
      // A PAN-only (Deoleo-style) row carries no no-PAN identity / unlinked flag / deposit months.
      expect(Object.keys(r).sort()).toEqual([
        'baseFyTotalPaise', 'carryForwardDroppedPaise', 'cashBasePaise', 'clientBorneBasePaise', 'clientBorneLiabilityPaise', 'deductBasePaise',
        'deductLiabilityPaise', 'deductedPaise', 'depositedPaise', 'excessDeductedPaise', 'fyLabel', 'importedVendorDepositPaise',
        'liabilityPaise', 'methodology', 'nonCashBasePaise', 'outstandingPaise', 'panNumber', 'ratePct',
      ]);
    }
  });

  it('194C DEP-1: a direct PAN deposit with NO payouts this FY → its own row; export numeric; totals = Σ rows', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([
      { id: 'p', pan: 'ABCDE1234F', owner: 'P', outlets: ['OP'], entityType: 'COMPANY' },
      { id: 'q', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'], entityType: 'COMPANY' },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'vis', 12_000_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'abcde1234f', outletCode: null, clientId: null, amountPaise: 60_000n }]);
    const rows = await service.compute194C(FY);
    const p = rows.filter((r) => r.panNumber === 'ABCDE1234F');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      baseFyTotalPaise: 0n, liabilityPaise: 0n, liabilityNoThresholdPaise: 0n, thresholdMet: false,
      depositedPaise: 60_000n, withheldPaise: 0n, outstandingPaise: -60_000n,
    });
    const sum = await service.summary194C(FY);
    const s = sumRows(rows);
    expect(sum.totalDepositedPaise).toBe(60_000n);
    expect(sum.totalDepositedPaise).toBe(s.deposited);
    expect(sum.totalBasePaise).toBe(s.base);
    expect(sum.totalLiabilityPaise).toBe(s.liability);
    expect(sum.totalOutstandingPaise).toBe(s.outstanding);
    expect(sum.rowCount).toBe(rows.length);

    const { buffer } = await service.export194C(FY);
    const xr = parseSheet(buffer).find((r) => r.PAN === 'ABCDE1234F')!;
    expect(xr['Amount Paid (₹)']).toBe(0);
    expect(xr['Already Deposited (₹)']).toBe(600);
    expect(xr['Outstanding (₹)']).toBe(-600);
  });

  it('194C DEP-2: a PAN with payouts AND a deposit → ONE row (no duplicate)', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([{ id: 'q', pan: 'QQQQQ1234Q', owner: 'Q', outlets: ['OQ'], entityType: 'COMPANY' }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OQ', 'vis', 12_000_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'qqqqq1234q', outletCode: null, clientId: null, amountPaise: 30_000n }]);
    const rows = await service.compute194C(FY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ panNumber: 'QQQQQ1234Q', baseFyTotalPaise: 12_000_000n, depositedPaise: 30_000n });
    expect(rows[0].outstandingPaise).toBe(rows[0].liabilityPaise - 30_000n);
  });

  it('194C DEP-3 (Deoleo case): every deposit PAN has payouts → exactly the payee rows', async () => {
    mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis', clientId: CLIENT }]);
    wire([
      { id: 'a', pan: 'AAAAA1111A', owner: 'A', outlets: ['OA'], entityType: 'COMPANY' },
      { id: 'b', pan: 'BBBBB2222B', owner: 'B', outlets: ['OB'], entityType: 'COMPANY' },
    ]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('OA', 'vis', 12_000_000n), entry('OB', 'vis', 500_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'AAAAA1111A', outletCode: null, clientId: null, amountPaise: 70_000n }]);
    const rows = await service.compute194C(FY);
    expect(rows.map((r) => [r.panNumber, r.baseFyTotalPaise, r.depositedPaise])).toEqual([
      ['AAAAA1111A', 12_000_000n, 70_000n],
      ['BBBBB2222B', 500_000n, 0n],
    ]);
  });
});
