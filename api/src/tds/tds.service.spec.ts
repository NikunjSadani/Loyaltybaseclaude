/**
 * Unit tests for TdsService — mock Prisma, no I/O.
 * Run: npx jest src/tds/tds.service.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TdsService } from './tds.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  creditField: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  tdsOffPlatformEntry: { findMany: jest.fn() },
  tdsDeposit: { findMany: jest.fn() },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a CreditPayoutEntry stub. */
const mkEntry = (outletId: string, fieldId: string, amountPaise: bigint, paidAt = new Date('2025-08-01')) => ({
  amountPaise,
  fieldId,
  outletId,
  paidAt,
  status: 'PAID',
});

const CLIENT_ID = 'deoleo';
const FY = '2025-26';

describe('TdsService', () => {
  let service: TdsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(TdsService);

    // Safe defaults — return empty arrays unless overridden
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
  });

  // ─── 194R: below threshold ────────────────────────────────────────────────

  describe('compute194R — below threshold', () => {
    it('returns liability = 0 when fyTotal <= ₹20,000 (2,000,000 paise)', async () => {
      // ₹19,999 = 1,999,900 paise — just under the ₹20,000 threshold
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 1_999_900n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].panNumber).toBe('ABCDE1234F');
      expect(rows[0].baseFyTotalPaise).toBe(1_999_900n);
      expect(rows[0].liabilityPaise).toBe(0n);
      expect(rows[0].outstandingPaise).toBe(0n);
    });

    it('returns liability = 0 when fyTotal == ₹20,000 exactly (threshold is STRICTLY greater)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      const rows = await service.compute194R(CLIENT_ID, FY);
      expect(rows[0].liabilityPaise).toBe(0n);
    });
  });

  // ─── 194R: above threshold (PAN) ─────────────────────────────────────────

  describe('compute194R — above threshold, PAN holder', () => {
    it('applies 10/90 grossing-up on the WHOLE fyTotal once threshold crossed', async () => {
      // ₹21,000 = 2,100,000 paise → TDS = 2100000 × 10/90 = 233333.3 → round → 233300
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_100_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].baseFyTotalPaise).toBe(2_100_000n);
      // 2100000 * 10 = 21000000; 21000000 / 90 = 233333n (floor); round(233333) = (233333+50)/100*100 = 233300
      expect(rows[0].liabilityPaise).toBe(233300n);
      expect(rows[0].outstandingPaise).toBe(233300n);
    });
  });

  // ─── 194R: no-PAN 20% ────────────────────────────────────────────────────

  describe('compute194R — no-PAN bucket', () => {
    it('groups null-PAN entries into __NO_PAN__ and applies 20/80', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_100_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      // Partner has no PAN
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: null }]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].panNumber).toBe('__NO_PAN__');
      // 2100000 * 20 = 42000000; 42000000 / 80 = 525000; round(525000) = 525000
      expect(rows[0].liabilityPaise).toBe(525000n);
    });

    it('groups outlet-with-no-partner into __NO_PAN__ correctly', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_500_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: null }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);

      const rows = await service.compute194R(CLIENT_ID, FY);
      expect(rows[0].panNumber).toBe('__NO_PAN__');
      expect(rows[0].liabilityPaise).toBeGreaterThan(0n);
    });
  });

  // ─── 194R: redemption valuePaise included ────────────────────────────────

  describe('compute194R — redemption valuePaise included', () => {
    it('adds RedemptionOrder.valuePaise to the PAN FY total', async () => {
      // Payout entry: ₹10,000 (below threshold alone)
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 1_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      // Redemption: ₹15,000 more via same partner → combined ₹25,000 > threshold
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([
        {
          valuePaise: 1_500_000n,
          status: 'DELIVERED',
          partner: { panNumber: 'ABCDE1234F' },
        },
      ]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].baseFyTotalPaise).toBe(2_500_000n); // 1M + 1.5M
      // 2500000 * 10 / 90 = 277777.7 → round → 277800
      expect(rows[0].liabilityPaise).toBe(277800n);
    });
  });

  // ─── 194R: off-platform entry included ───────────────────────────────────

  describe('compute194R — off-platform entry', () => {
    it('includes TdsOffPlatformEntry in the PAN total', async () => {
      // No on-platform payouts
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      // Off-platform: ₹25,000 for a PAN
      mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([
        { panNumber: 'XYZAB5678G', amountPaise: 2_500_000n },
      ]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].panNumber).toBe('XYZAB5678G');
      expect(rows[0].baseFyTotalPaise).toBe(2_500_000n);
      expect(rows[0].liabilityPaise).toBeGreaterThan(0n);
    });
  });

  // ─── 194R: deposited subtracted → outstanding ────────────────────────────

  describe('compute194R — deposited subtracted', () => {
    it('subtracts TdsDeposit from liability to give outstanding', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_100_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      // Deposited ₹1,000 = 100,000 paise
      mockPrisma.tdsDeposit.findMany.mockResolvedValue([
        { panNumber: 'ABCDE1234F', amountPaise: 100_000n },
      ]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows[0].depositedPaise).toBe(100_000n);
      // liability = 233300; outstanding = 233300 - 100000 = 133300
      expect(rows[0].outstandingPaise).toBe(rows[0].liabilityPaise - 100_000n);
    });
  });

  // ─── 194R: visibility entries excluded ───────────────────────────────────

  describe('compute194R — visibility entries excluded', () => {
    it('does NOT count entries from isSeparatePayout fields in 194R', async () => {
      // Two entries: one normal field, one visibility field
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field-normal', 2_000_100n),
        mkEntry('outlet1', 'field-vis', 5_000_000n),
      ]);
      // Only the normal field should be counted for 194R
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'field-vis', clientId: CLIENT_ID }]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'cp1', panNumber: 'ABCDE1234F' }]);

      const rows = await service.compute194R(CLIENT_ID, FY);

      expect(rows).toHaveLength(1);
      // Only 2,000,100 counted (just above threshold) — 5M visibility excluded
      expect(rows[0].baseFyTotalPaise).toBe(2_000_100n);
    });
  });

  // ─── 194C: two columns + threshold logic ─────────────────────────────────

  describe('compute194C — two columns + threshold', () => {
    beforeEach(() => {
      // One visibility field
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
    });

    it('produces (a) 0 and (b) non-zero when below both thresholds', async () => {
      // Single payment ₹10,000 (below ₹30,000 single threshold) and FY total ₹10,000 (below ₹1,00,000)
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', 1_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'ABCDE1234F', entityType: 'COMPANY' },
      ]);

      const rows = await service.compute194C(FY);

      expect(rows).toHaveLength(1);
      expect(rows[0].thresholdMet).toBe(false);
      expect(rows[0].liabilityPaise).toBe(0n); // (a) with-threshold
      expect(rows[0].liabilityNoThresholdPaise).toBeGreaterThan(0n); // (b) no-threshold
    });

    it('triggers on single payment > ₹30,000 (3,000,000 paise)', async () => {
      // Single payment ₹31,000 > ₹30,000 single threshold → threshold met
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', 3_100_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'ABCDE1234F', entityType: 'COMPANY' },
      ]);

      const rows = await service.compute194C(FY);

      expect(rows[0].thresholdMet).toBe(true);
      expect(rows[0].liabilityPaise).toBeGreaterThan(0n); // (a) also applies
    });

    it('triggers on fyTotal > ₹1,00,000 (10,000,000 paise)', async () => {
      // Two payments of ₹60,000 each = ₹1,20,000 cumulative → FY threshold met
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', 6_000_000n),
        mkEntry('outlet1', 'vis-field', 6_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'ABCDE1234F', entityType: 'FIRM' },
      ]);

      const rows = await service.compute194C(FY);

      // Total: 12,000,000 paise > 10,000,000 → threshold met
      expect(rows[0].baseFyTotalPaise).toBe(12_000_000n);
      expect(rows[0].thresholdMet).toBe(true);
    });
  });

  // ─── 194C: 1% vs 2% by entity type ──────────────────────────────────────

  describe('compute194C — 1% INDIVIDUAL vs 2% OTHERS', () => {
    beforeEach(() => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
    });

    it('applies 1/99 (INDIVIDUAL) → lower TDS than 2/98 (COMPANY)', async () => {
      const base = 12_000_000n; // ₹1,20,000 — above FY threshold

      // INDIVIDUAL
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', base),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'IND001', entityType: 'INDIVIDUAL' },
      ]);

      const [rowsInd] = await Promise.all([service.compute194C(FY)]);
      const indTds = rowsInd[0].liabilityPaise;

      jest.clearAllMocks();
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', base),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp2' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp2', panNumber: 'COM001', entityType: 'COMPANY' },
      ]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
      mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);

      const rowsCom = await service.compute194C(FY);
      const comTds = rowsCom[0].liabilityPaise;

      // INDIVIDUAL rate (1/99) should produce less TDS than COMPANY (2/98)
      expect(indTds).toBeLessThan(comTds);

      // Validate exact values
      // INDIVIDUAL: 12000000 * 1 / 99 = 121212.12... → round → 121200
      expect(indTds).toBe(121200n);
      // COMPANY: 12000000 * 2 / 98 = 244897.95... → round → 244900
      expect(comTds).toBe(244900n);
    });

    it('applies 20/80 for no-PAN partner', async () => {
      const base = 12_000_000n;
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', base),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: null, entityType: 'COMPANY' },
      ]);

      const rows = await service.compute194C(FY);

      expect(rows[0].panNumber).toBe('__NO_PAN__');
      // 12000000 * 20 / 80 = 3000000; round(3000000) = 3000000
      expect(rows[0].liabilityPaise).toBe(3_000_000n);
      expect(rows[0].liabilityNoThresholdPaise).toBe(3_000_000n);
    });
  });

  // ─── 194C: deposited subtracted ──────────────────────────────────────────

  describe('compute194C — deposited subtracted', () => {
    it('subtracts TdsDeposit (SEC_194C) from (a) liability for outstanding', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'vis-field', clientId: CLIENT_ID }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'vis-field', 12_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'outlet1', partnerId: 'cp1' }]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'ABCDE1234F', entityType: 'COMPANY' },
      ]);
      mockPrisma.tdsDeposit.findMany.mockResolvedValue([
        { panNumber: 'ABCDE1234F', amountPaise: 100_000n },
      ]);

      const rows = await service.compute194C(FY);

      expect(rows[0].depositedPaise).toBe(100_000n);
      expect(rows[0].outstandingPaise).toBe(rows[0].liabilityPaise - 100_000n);
    });
  });

  // ─── summary194R ──────────────────────────────────────────────────────────

  describe('summary194R', () => {
    it('aggregates totals across rows', async () => {
      // Two PANs both above threshold
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        mkEntry('outlet1', 'field1', 2_100_000n),
        mkEntry('outlet2', 'field1', 3_000_000n),
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'outlet1', partnerId: 'cp1' },
        { outletCode: 'outlet2', partnerId: 'cp2' },
      ]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'cp1', panNumber: 'PAN001' },
        { id: 'cp2', panNumber: 'PAN002' },
      ]);

      const summary = await service.summary194R(CLIENT_ID, FY);

      expect(summary.totalBasePaise).toBe(5_100_000n);
      expect(summary.totalLiabilityPaise).toBeGreaterThan(0n);
      expect(summary.rowCount).toBe(2);
      expect(summary.clientId).toBe(CLIENT_ID);
      expect(summary.fyLabel).toBe(FY);
    });
  });
});
