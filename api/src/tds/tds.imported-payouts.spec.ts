/**
 * 194R — per-tenant "count imported (VENDOR_IMPORT) payouts from <date>" (ProgramSetting
 * `tdsImportedPayouts` = { countFrom }). Default OFF → the report is byte-identical (imported
 * history excluded); ON → imported payouts paid on/after the IST date count like any other paid
 * incentive (PAN / per-deductee no-PAN keys, FY threshold, deposits subtract). REPORT-ONLY.
 * Run: npx jest src/tds/tds.imported-payouts.spec.ts
 */
import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as XLSX from 'xlsx';
import { TdsService } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { TdsStatutoryConfigService } from './tds-statutory.config.service';
import {
  DEFAULT_RESOLVED_TDS_STATUTORY,
  grossUpTdsPaise,
  rate194RFrom,
  parseImportedPayoutsSetting,
  istDayStartInstant,
  importedCountFromForFy,
  importedCountFromBounds,
} from './tds.helpers';

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
  programSetting: { findUnique: jest.fn() },
};

let seq = 0;
const entry = (outletId: string, amountPaise: bigint, period = '2026-06') => ({
  id: `x${++seq}`,
  amountPaise,
  fieldId: 'historical-incentive-payout',
  outletId,
  tdsSection: null,
  period,
});

const CLIENT = 'bajaj';
const PAN = 'ABCDE1234F';
const PAN_RATE = rate194RFrom(DEFAULT_RESOLVED_TDS_STATUTORY, true);
const NO_PAN_RATE = rate194RFrom(DEFAULT_RESOLVED_TDS_STATUTORY, false);

/** Route creditPayoutEntry.findMany by query shape: regular paidAt window vs the imported query. */
function payoutEntries(regular: unknown[], imported: unknown[]) {
  mockPrisma.creditPayoutEntry.findMany.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    if (w.batch?.sourceKind === 'VENDOR_IMPORT') return imported;
    if (w.paidAt) return regular;
    return [];
  });
}

const importedCalls = () =>
  mockPrisma.creditPayoutEntry.findMany.mock.calls.filter((c) => c[0]?.where?.batch?.sourceKind === 'VENDOR_IMPORT');

const setting = (value: unknown) =>
  mockPrisma.programSetting.findUnique.mockResolvedValue(value === undefined ? null : { settingValue: value });

describe('TdsService — imported (VENDOR_IMPORT) payouts in 194R', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
      ],
    }).compile();
    service = module.get(TdsService);
    payoutEntries([], []);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'R1', partnerId: 'cp1' },
      { outletCode: 'R2', partnerId: 'cp2' },
    ]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([
      { id: 'cp1', panNumber: PAN },
      { id: 'cp2', panNumber: null, clientId: CLIENT, ownerName: 'No Pan Traders', businessName: null },
    ]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([]);
    setting(undefined);
  });

  // ── OFF (default) ──────────────────────────────────────────────────────────
  describe('setting OFF (Deoleo / every tenant by default)', () => {
    it('absent row: the imported query is never issued and imported rows never count', async () => {
      payoutEntries([entry('R1', 1_500_000n)], [entry('R1', 9_000_000n)]);
      const rows = await service.compute194R(CLIENT, '2026-27');
      expect(importedCalls()).toHaveLength(0);
      expect(rows).toHaveLength(1);
      expect(rows[0].baseFyTotalPaise).toBe(1_500_000n);
      expect(rows[0].liabilityPaise).toBe(0n);
    });

    it('OFF output is IDENTICAL to a service whose Prisma has no programSetting at all (legacy, countFrom passed as null)', async () => {
      payoutEntries([entry('R1', 2_500_000n), entry('R2', 2_100_000n)], [entry('R1', 9_000_000n)]);
      const off = await service.compute194R(CLIENT, '2026-27');

      const legacyPrisma = { ...mockPrisma } as Record<string, unknown>;
      delete legacyPrisma.programSetting;
      const legacy = new TdsService(legacyPrisma as unknown as PrismaService, mockStatutory as unknown as TdsStatutoryConfigService);
      const legacyRows = await legacy.compute194R(CLIENT, '2026-27', null);
      expect(off).toEqual(legacyRows);
      expect(importedCalls()).toHaveLength(0);
    });

    it('explicit { countFrom: null } resolves to OFF', async () => {
      setting({ countFrom: null });
      expect(await service.importedPayoutsCountFrom(CLIENT)).toBeNull();
    });
  });

  // ── FAIL CLOSED ────────────────────────────────────────────────────────────
  describe('fail closed (never silently OFF)', () => {
    it.each([['a bare string', '2026-04-01'], ['an impossible date', { countFrom: '2026-02-30' }], ['junk', { countFrom: 'soon' }], ['an array', []], ['a number', 42]])(
      'a malformed stored value (%s) THROWS — the report is not produced',
      async (_label, v) => {
        setting(v);
        await expect(service.importedPayoutsCountFrom(CLIENT)).rejects.toThrow(InternalServerErrorException);
        await expect(service.compute194R(CLIENT, '2026-27')).rejects.toThrow(InternalServerErrorException);
        await expect(service.report194R(CLIENT, '2026-27')).rejects.toThrow(InternalServerErrorException);
        expect(importedCalls()).toHaveLength(0);
      },
    );

    it('a failed setting read THROWS (no silent fallback to OFF)', async () => {
      mockPrisma.programSetting.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.report194R(CLIENT, '2026-27')).rejects.toThrow(InternalServerErrorException);
      await expect(service.export194R(CLIENT, '2026-27')).rejects.toThrow(InternalServerErrorException);
      await expect(service.getLiability('194R', '2026-27', CLIENT)).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── ONE read per request + FY-scoped disclosure ────────────────────────────
  describe('report194R (one read per request) + disclosure', () => {
    beforeEach(() => setting({ countFrom: '2026-04-01' }));

    it('reads the setting ONCE and computes rows ONCE; summary is derived from the same rows', async () => {
      payoutEntries([entry('R1', 1_000_000n)], [entry('R1', 1_500_000n)]);
      const r = await service.report194R(CLIENT, '2026-27');
      expect(mockPrisma.programSetting.findUnique).toHaveBeenCalledTimes(1);
      expect(importedCalls()).toHaveLength(1);
      expect(r.summary.totalBasePaise).toBe(2_500_000n);
      expect(r.summary.rowCount).toBe(r.rows.length);
    });

    it('FY 2026-27 (date inside the FY) → importedPayoutsCountedFrom + note', async () => {
      const r = await service.report194R(CLIENT, '2026-27');
      expect(r.importedPayoutsCountedFrom).toBe('2026-04-01');
      expect(r.importedPayoutsNote).toBe('Includes imported (vendor) payouts paid on/after 1 Apr 2026');
    });

    it('FY 2025-26 with countFrom 2026-04-01 (on/after the FY end) → NO note', async () => {
      const r = await service.report194R(CLIENT, '2025-26');
      expect(r.importedPayoutsCountedFrom).toBeNull();
      expect(r.importedPayoutsNote).toBeNull();
    });

    it('getLiability 194R carries the note only when it applies to the FY', async () => {
      const on = await service.getLiability('194R', '2026-27', CLIENT);
      expect(on.importedPayoutsCountedFrom).toBe('2026-04-01');
      expect(on.importedPayoutsNote).toBe('Includes imported (vendor) payouts paid on/after 1 Apr 2026');
      const off = await service.getLiability('194R', '2025-26', CLIENT);
      expect(off).not.toHaveProperty('importedPayoutsCountedFrom');
      expect(off).not.toHaveProperty('importedPayoutsNote');
    });

    it('export194R Summary sheet states the note only when it applies to the FY', async () => {
      const summaryRows = async (fy: string) => {
        const { buffer } = await service.export194R(CLIENT, fy);
        const wb = XLSX.read(buffer, { type: 'buffer' });
        return XLSX.utils.sheet_to_json<{ Field: string; Value: unknown }>(wb.Sheets['Summary']);
      };
      const on = await summaryRows('2026-27');
      const note = on.find((r) => r.Field === 'Imported (vendor) payouts');
      expect(String(note?.Value)).toContain('Includes imported (vendor) payouts paid on/after 1 Apr 2026');
      const off = await summaryRows('2025-26');
      expect(off.find((r) => r.Field === 'Imported (vendor) payouts')).toBeUndefined();
    });
  });

  // ── ON from 2026-04-01 ─────────────────────────────────────────────────────
  describe('setting ON, countFrom = 2026-04-01', () => {
    beforeEach(() => setting({ countFrom: '2026-04-01' }));

    it('FY 2026-27: imported payouts are counted; the query is PAID + VENDOR_IMPORT + paidAt ≥ 1 Apr 2026 00:00 IST', async () => {
      payoutEntries([], [entry('R1', 1_200_000n), entry('R1', 1_000_000n, '2026-08')]);
      const rows = await service.compute194R(CLIENT, '2026-27');

      const calls = importedCalls();
      expect(calls).toHaveLength(1);
      const where = calls[0][0].where;
      // BOTH filters: VENDOR_IMPORT batch AND the vendor incentive-payout fieldId — a future
      // vendor-import batch of another kind is never swept in automatically.
      expect(where).toMatchObject({
        clientId: CLIENT,
        status: 'PAID',
        fieldId: 'historical-incentive-payout',
        batch: { sourceKind: 'VENDOR_IMPORT' },
      });
      expect(where.paidAt.gte.toISOString()).toBe('2026-03-31T18:30:00.000Z');
      expect(where.paidAt.lt.toISOString()).toBe('2027-03-31T18:30:00.000Z');

      expect(rows).toHaveLength(1);
      expect(rows[0].panNumber).toBe(PAN);
      expect(rows[0].baseFyTotalPaise).toBe(2_200_000n);
      expect(rows[0].liabilityPaise).toBe(grossUpTdsPaise(2_200_000n, PAN_RATE));
    });

    it('FY 2025-26: imported payouts stay EXCLUDED (date is after that FY → no imported query)', async () => {
      payoutEntries([entry('R1', 500_000n, '2025-06')], [entry('R1', 9_000_000n, '2025-06')]);
      const rows = await service.compute194R(CLIENT, '2025-26');
      expect(importedCalls()).toHaveLength(0);
      expect(rows[0].baseFyTotalPaise).toBe(500_000n);
      expect(rows[0].liabilityPaise).toBe(0n);
    });

    it('threshold crossing: platform ₹15,000 + imported ₹6,000 → ₹21,000 > ₹20,000 → liability on the WHOLE base', async () => {
      payoutEntries([entry('R1', 1_500_000n)], [entry('R1', 600_000n)]);
      const [row] = await service.compute194R(CLIENT, '2026-27');
      expect(row.baseFyTotalPaise).toBe(2_100_000n);
      expect(row.liabilityPaise).toBe(grossUpTdsPaise(2_100_000n, PAN_RATE));
      expect(row.liabilityPaise).toBeGreaterThan(0n);
    });

    it('exactly ₹20,000 imported does NOT cross (threshold is "exceeds")', async () => {
      payoutEntries([], [entry('R1', 2_000_000n)]);
      const [row] = await service.compute194R(CLIENT, '2026-27');
      expect(row.liabilityPaise).toBe(0n);
    });

    it('no-PAN outlet → its own __NO_PAN__:<partnerId> deductee at the no-PAN rate', async () => {
      payoutEntries([], [entry('R2', 2_500_000n)]);
      const rows = await service.compute194R(CLIENT, '2026-27');
      expect(rows).toHaveLength(1);
      expect(rows[0].panNumber).toBe('__NO_PAN__:cp2');
      expect(rows[0].liabilityPaise).toBe(grossUpTdsPaise(2_500_000n, NO_PAN_RATE));
      expect(rows[0].noPanDeductee?.name).toBe('No Pan Traders');
    });

    it('a deposit "for" a FY 2026-27 month subtracts from the imported liability', async () => {
      payoutEntries([], [entry('R1', 3_000_000n)]);
      mockPrisma.tdsDeposit.findMany.mockResolvedValue([
        { panNumber: PAN, amountPaise: 100_000n, outletCode: null, clientId: CLIENT, forPeriod: '2026-06', depositDate: new Date('2026-07-07') },
      ]);
      const [row] = await service.compute194R(CLIENT, '2026-27');
      const liability = grossUpTdsPaise(3_000_000n, PAN_RATE);
      expect(row.liabilityPaise).toBe(liability);
      expect(row.depositedPaise).toBe(100_000n);
      expect(row.outstandingPaise).toBe(liability - 100_000n);
      expect(row.depositForPeriods).toEqual(['2026-06']);
    });

    it('an entry in BOTH queries is counted once (union by id)', async () => {
      const e = entry('R1', 2_500_000n);
      payoutEntries([e], [e]);
      const [row] = await service.compute194R(CLIENT, '2026-27');
      expect(row.baseFyTotalPaise).toBe(2_500_000n);
    });

    it('summary194R totals include the imported base', async () => {
      payoutEntries([entry('R1', 1_000_000n)], [entry('R1', 1_500_000n), entry('R2', 2_500_000n)]);
      const s = await service.summary194R(CLIENT, '2026-27');
      expect(s.totalBasePaise).toBe(5_000_000n);
      expect(s.rowCount).toBe(2);
    });
  });

  describe('mid-FY date', () => {
    it('countFrom 2026-07-01 → the imported query starts at 1 Jul 2026 00:00 IST (earlier FY months excluded)', async () => {
      setting({ countFrom: '2026-07-01' });
      await service.compute194R(CLIENT, '2026-27');
      const where = importedCalls()[0][0].where;
      expect(where.paidAt.gte.toISOString()).toBe('2026-06-30T18:30:00.000Z');
    });

    it('countFrom before the FY start → clamped to the FY start', async () => {
      setting({ countFrom: '2025-04-01' });
      await service.compute194R(CLIENT, '2026-27');
      expect(importedCalls()[0][0].where.paidAt.gte.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    });
  });

  // ── Report-only: no write, no withholding input ────────────────────────────
  describe('report-only', () => {
    it('compute194R ON performs READS only (no create/update/delete on any model)', async () => {
      setting({ countFrom: '2026-04-01' });
      payoutEntries([entry('R1', 1_500_000n)], [entry('R1', 6_000_000n)]);
      const writes: string[] = [];
      const guarded = new Proxy(mockPrisma, {
        get(target, model: string) {
          const delegate = (target as Record<string, Record<string, unknown>>)[model];
          if (!delegate || typeof delegate !== 'object') return delegate;
          return new Proxy(delegate, {
            get(d, op: string) {
              if (!/^(find|count|aggregate|groupBy)/.test(op)) writes.push(`${model}.${op}`);
              return d[op];
            },
          });
        },
      });
      const svc = new TdsService(guarded as unknown as PrismaService, mockStatutory as unknown as TdsStatutoryConfigService);
      await svc.compute194R(CLIENT, '2026-27');
      expect(writes).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('parseImportedPayoutsSetting', () => {
      expect(parseImportedPayoutsSetting(undefined)).toEqual({ countFrom: null, malformed: false });
      expect(parseImportedPayoutsSetting({ countFrom: null })).toEqual({ countFrom: null, malformed: false });
      expect(parseImportedPayoutsSetting({ countFrom: '2026-04-01' })).toEqual({ countFrom: '2026-04-01', malformed: false });
      expect(parseImportedPayoutsSetting({ countFrom: '2026-13-01' })).toEqual({ countFrom: null, malformed: true });
      expect(parseImportedPayoutsSetting('2026-04-01')).toEqual({ countFrom: null, malformed: true });
    });
    it('istDayStartInstant = 00:00 IST', () => {
      expect(istDayStartInstant('2026-04-01').toISOString()).toBe('2026-03-31T18:30:00.000Z');
    });
    it('importedCountFromForFy: disclosed only when the date is before the FY end', () => {
      expect(importedCountFromForFy(null, '2026-27')).toBeNull();
      expect(importedCountFromForFy('2026-04-01', '2025-26')).toBeNull();
      expect(importedCountFromForFy('2026-03-31', '2025-26')).toBe('2026-03-31');
      expect(importedCountFromForFy('2026-04-01', '2026-27')).toBe('2026-04-01');
      expect(importedCountFromForFy('2024-04-01', '2026-27')).toBe('2024-04-01');
    });
    it('importedCountFromBounds: [2000-01-01, today(IST) + 1 year]', () => {
      expect(importedCountFromBounds(new Date('2026-11-13T10:00:00Z'))).toEqual({ min: '2000-01-01', max: '2027-11-13' });
      // 23:00 UTC on 31 Dec = 1 Jan IST
      expect(importedCountFromBounds(new Date('2026-12-31T23:00:00Z')).max).toBe('2028-01-01');
      // 29 Feb + 1y → 28 Feb
      expect(importedCountFromBounds(new Date('2028-02-29T06:00:00Z')).max).toBe('2029-02-28');
    });
  });
});
