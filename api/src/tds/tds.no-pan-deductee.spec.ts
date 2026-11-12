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

const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };

const mockPrisma = {
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
function wire(partners: PartnerFx[], ownerless: Array<{ outletCode: string; name: string }> = []) {
  const outletRows = [
    ...partners.flatMap((p) => p.outlets.map((o) => ({ outletCode: o, partnerId: p.id, clientId: CLIENT, name: `${o}-name` }))),
    ...ownerless.map((o) => ({ outletCode: o.outletCode, partnerId: null, clientId: CLIENT, name: o.name })),
  ];
  mockPrisma.outlet.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    return outletRows.filter((o) => {
      if (w.partnerId?.in && !w.partnerId.in.includes(o.partnerId)) return false;
      if (w.outletCode?.in && !w.outletCode.in.includes(o.outletCode)) return false;
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
    expect(pan).toEqual({
      panNumber: 'ABCDE1234F', fyLabel: FY, baseFyTotalPaise: 2_100_000n,
      liabilityPaise: 233_300n, depositedPaise: 0n, outstandingPaise: 233_300n,
    });
    expect(pan.noPanDeductee).toBeUndefined();
  });

  it('194R: a no-PAN deposit with an Outlet Code nets against THAT deductee; one without lands in the unattributed bucket', async () => {
    wire([{ id: 'big', pan: null, owner: 'Big', outlets: ['B1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('B1', 'f1', 2_500_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([
      { panNumber: '__NO_PAN__', outletCode: 'B1', amountPaise: 600_000n },
      { panNumber: '__NO_PAN__', outletCode: null, amountPaise: 100_000n }, // legacy pooled-style deposit
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    const big = rows.find((r) => r.panNumber === '__NO_PAN__:big')!;
    expect(big.depositedPaise).toBe(600_000n);
    expect(big.outstandingPaise).toBe(25_000n);
    const unattributed = rows.find((r) => r.panNumber === '__NO_PAN__')!;
    expect(unattributed).toMatchObject({ baseFyTotalPaise: 0n, liabilityPaise: 0n, depositedPaise: 100_000n, outstandingPaise: -100_000n });
    expect(unattributed.noPanDeductee).toBeUndefined();
    // totals stay whole: every deposit rupee is still counted
    const summary = await service.summary194R(CLIENT, FY);
    expect(summary.totalDepositedPaise).toBe(700_000n);
  });

  it('194R: Deoleo-style tenant (PAN partners only) — identical rows, no extra queries', async () => {
    wire([{ id: 'cp1', pan: 'ABCDE1234F', owner: 'A', outlets: ['O1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('O1', 'f1', 2_100_000n)]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([{ panNumber: 'ABCDE1234F', outletCode: null, amountPaise: 100_000n }]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toEqual([
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
    expect(big['TDS Amount (₹)']).toBe('6250.00');
    const small = rows.find((r) => r['Deductee Name'] === 'Small Owner (NO PAN ON FILE)')!;
    expect(small['TDS Amount (₹)']).toBe('0.00');
    const pan = rows.find((r) => r.PAN === 'ABCDE1234F')!;
    expect(pan['Deductee Name']).toBe('Pan Owner');
    expect(pan['Outlet Code']).toBe('');
    expect(pan['TDS Rate %']).toBe(10);
  });

  it('export194R: PAN-only tenant → exact legacy column set (no Outlet Code column)', async () => {
    wire([{ id: 'cp1', pan: 'ABCDE1234F', owner: 'A', outlets: ['O1'] }]);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([entry('O1', 'f1', 2_100_000n)]);
    const { buffer } = await service.export194R(CLIENT, FY);
    expect(headers(buffer)).toEqual([
      'S.No', 'Deductee Name', 'PAN', 'Section', 'Amount Paid (₹)', 'TDS Rate %',
      'TDS Amount (₹)', 'Already Deposited (₹)', 'Outstanding (₹)', 'FY',
    ]);
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
    expect(rows.map((r) => r.panNumber).sort()).toEqual(['__NO_PAN__:a', '__NO_PAN__:b']);
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
    expect(rows[0].panNumber).toBe('__NO_PAN__:a');
    expect(rows[0].liabilityPaise).toBe(3_000_000n);
    expect(rows[0].recoveredPaise).toBe(3_000_000n);
    expect(rows[0].recoveryByTenant).toEqual([{ clientId: CLIENT, tenantSharePaise: 3_000_000n }]);
    expect(rows[0].noPanDeductee).toMatchObject({ partnerId: 'a', name: 'A', outletCodes: ['OA'] });
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
});
