/**
 * WHOLE-MODULE MONEY / 194R / VALUE audit — Gift Catalogue & Dispatch.
 *
 * Adversarial edge-case regression pack for the CANONICAL VALUE path (design §14)
 * and its consumers (194R Source-2, the disbursal report, the backfill). These are
 * NEW assertions that were not already covered by:
 *   - gift-value.helper.spec.ts          (basic freeze / rate-immunity)
 *   - gift-backfill.service.spec.ts      (basic ÷rate / FREE_AMOUNT skip / dedup)
 *   - rewards.service.spec.ts            (transitionOrder RETURNED reversal, refund guard)
 *   - tds.service.spec.ts                (single Source-2 add)
 *   - order-number.helper.spec.ts        (format/monotonic)
 *
 * Focus: exhaustive VALUE-EXACTNESS edges — qty scale, rate-change decoupling, two
 * redeems at different rates, huge/odd paise (no float drift), Source-2 cumulation
 * across many orders + PAN, RETURNED/PENDING/FREE_AMOUNT exclusion, BigInt JSON
 * serialisation losslessness.
 *
 * Run: cd api && npx jest src/rewards/e2e-money-audit.spec.ts --no-coverage
 */
import { Test, TestingModule } from '@nestjs/testing';
import { computeFrozenValuePaise } from './gift-value.helper';
import { backfillSellingValuePaise, isFreeAmountRow } from '../gift-catalogue/gift-backfill.service';
import { TdsService } from '../tds/tds.service';
import { PrismaService } from '../prisma/prisma.service';
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY } from '../tds/tds.helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// A. CANONICAL VALUE FREEZE — exhaustive money-exactness edges (pure helper)
// ═══════════════════════════════════════════════════════════════════════════════
describe('A. computeFrozenValuePaise — value-exactness edges (design §14)', () => {
  const gift = (over: Partial<Parameters<typeof computeFrozenValuePaise>[0]> = {}) =>
    computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: 50000, // ₹500 / unit
      quantity: 1,
      points: 500,
      rateCenti: 100,
      ...over,
    });

  it('GIFT qty=1 → exactly the per-unit selling paise (no rounding of odd paise)', () => {
    // 12345 paise (₹123.45) must survive verbatim — the gift path does NOT rupee-round.
    expect(gift({ sellingValuePaiseSnapshot: 12345, quantity: 1 })).toBe(12345n);
  });

  it('GIFT qty>1 → per-unit × qty, exact (this IS the 194R base for the order)', () => {
    expect(gift({ sellingValuePaiseSnapshot: 12345, quantity: 7 })).toBe(86415n); // 12345 × 7
  });

  it('GIFT huge qty → BigInt exact, NO float drift / no 100× error', () => {
    // 1,000,000 units × ₹500 = ₹500,000,000 = 50,000,000,000 paise.
    const v = gift({ sellingValuePaiseSnapshot: 50000, quantity: 1_000_000 });
    expect(v).toBe(50_000_000_000n);
    expect(typeof v).toBe('bigint');
  });

  it('GIFT is RATE-IMMUNE across a rate change (same selling snapshot → same value at ANY rate)', () => {
    const atLowRate = gift({ rateCenti: 50 }); // rate 0.5
    const atHighRate = gift({ rateCenti: 100000 }); // rate 1000
    expect(atLowRate).toBe(50000n);
    expect(atHighRate).toBe(50000n); // unchanged — a rate change never re-values a placed gift
  });

  it('TWO redeems of the SAME gift at DIFFERENT rates → SAME frozen value (rate-immune)', () => {
    const first = gift({ rateCenti: 100 }); // redeemed at rate 1.0
    const second = gift({ rateCenti: 400 }); // rate later quadrupled
    expect(first).toBe(second); // gift value is decoupled from the rate
    expect(first).toBe(50000n);
  });

  it('CASH: TWO redeems of the SAME points at DIFFERENT rates → DIFFERENT frozen values', () => {
    // Cash keeps points ÷ rate, so the frozen payout DOES move with the rate.
    const atRate1 = computeFrozenValuePaise({
      isCashMode: true, sellingValuePaiseSnapshot: null, quantity: 1, points: 1000, rateCenti: 100,
    }); // 1000 / 1.0 = ₹1000
    const atRate2 = computeFrozenValuePaise({
      isCashMode: true, sellingValuePaiseSnapshot: null, quantity: 1, points: 1000, rateCenti: 200,
    }); // 1000 / 2.0 = ₹500
    expect(atRate1).toBe(100000n);
    expect(atRate2).toBe(50000n);
    expect(atRate1).not.toBe(atRate2);
  });

  it('GIFT: quantity=0 is treated as 1 (never zeroes a real gift value)', () => {
    // Defensive: a 0/blank qty must not silently zero the 194R base for a real gift.
    expect(gift({ sellingValuePaiseSnapshot: 50000, quantity: 0 })).toBe(50000n);
  });

  it('GIFT: negative quantity is coerced to 1 (never a NEGATIVE 194R contribution)', () => {
    // A negative qty × selling would otherwise produce a negative valuePaise that would
    // SUBTRACT from the outlet PAN 194R base — a tax-integrity hole. Guard coerces to 1.
    expect(gift({ sellingValuePaiseSnapshot: 50000, quantity: -3 })).toBe(50000n);
  });

  it('FREE_AMOUNT / no-snapshot (null) → falls back to points ÷ rate, qty NOT applied', () => {
    const v = computeFrozenValuePaise({
      isCashMode: false, sellingValuePaiseSnapshot: null, quantity: 5, points: 1000, rateCenti: 100,
    });
    expect(v).toBe(100000n); // ₹1000, not ×5 — the fallback is the real redeemed value
  });

  it('ZERO snapshot → fallback (guards the FREE_AMOUNT under-report: never a ₹0 194R base)', () => {
    const v = computeFrozenValuePaise({
      isCashMode: false, sellingValuePaiseSnapshot: 0, quantity: 3, points: 700, rateCenti: 100,
    });
    expect(v).toBe(70000n); // ₹700 fallback, not 0
  });

  it('fractional-rate fallback uses centi-rate integer math (no truncation), rupee-rounded', () => {
    // points 1000 at rate 0.5 (rateCenti 50) → ₹2000 → 200000 paise.
    const v = computeFrozenValuePaise({
      isCashMode: true, sellingValuePaiseSnapshot: null, quantity: 1, points: 1000, rateCenti: 50,
    });
    expect(v).toBe(200000n);
  });

  it('rate 0 misconfig on the fallback path → 0n (caller zero-value guard rejects cash)', () => {
    expect(
      computeFrozenValuePaise({ isCashMode: true, sellingValuePaiseSnapshot: null, quantity: 1, points: 1000, rateCenti: 0 }),
    ).toBe(0n);
  });

  it('a gift at rate 0 STILL freezes its selling value (gift path never touches the rate)', () => {
    // Even with a misconfigured rate, a gift order must carry its real ₹ value into 194R.
    expect(gift({ sellingValuePaiseSnapshot: 50000, quantity: 2, rateCenti: 0 })).toBe(100000n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. BACKFILL formula — value = round(pointsCost × 100 ÷ rate); ÷ rate (not ×)
// ═══════════════════════════════════════════════════════════════════════════════
describe('B. backfillSellingValuePaise — ÷rate, rounding, scale, idempotency signal', () => {
  it('÷ rate, NOT × rate (a × would inflate by rate²)', () => {
    // 1000 pts @ rate 4 → ₹250 → 25000 paise.  A ×rate bug would give ₹4000 = 400000.
    expect(backfillSellingValuePaise(1000, 4)).toBe(25000);
  });

  it('fractional rate handled (÷ 0.5 doubles the ₹ value)', () => {
    expect(backfillSellingValuePaise(1000, 0.5)).toBe(200000); // ₹2000
  });

  it('rounds to the nearest paise (half-up via Math.round)', () => {
    // 333 pts @ rate 7 → 333×100/7 = 4757.14… → round → 4757.
    expect(backfillSellingValuePaise(333, 7)).toBe(4757);
  });

  it('huge pointsCost — no overflow / no 100× drift', () => {
    // 10,000,000 pts @ rate 1 → ₹10,000,000 → 1,000,000,000 paise.
    expect(backfillSellingValuePaise(10_000_000, 1)).toBe(1_000_000_000);
  });

  it('rate 0 / negative → 0 (guarded; visible for manual correction, never rate² inflation)', () => {
    expect(backfillSellingValuePaise(1000, 0)).toBe(0);
    expect(backfillSellingValuePaise(1000, -2)).toBe(0);
  });

  it('backfill ₹→paise agrees with the confirm-time cash fallback for the same pts/rate', () => {
    // Backfill of a FIXED item and the runtime points÷rate freeze must land on the same
    // ₹ value (both are points ÷ rate, in paise), so a backfilled order and a fresh redeem
    // of the same item report the SAME 194R base.
    const rate = 2;
    const points = 1000;
    const backfilled = backfillSellingValuePaise(points, rate); // 50000 paise
    const runtime = computeFrozenValuePaise({
      isCashMode: true, sellingValuePaiseSnapshot: null, quantity: 1, points, rateCenti: rate * 100,
    });
    expect(BigInt(backfilled)).toBe(runtime); // 50000n
  });

  it('FREE_AMOUNT row is NOT value-filled (isFreeAmountRow gate) — leaves null for the fallback', () => {
    expect(isFreeAmountRow({ pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: 5000 })).toBe(true);
    // A ₹0 freeze here would zero the item's 194R base — the gate prevents it.
    expect(isFreeAmountRow({ pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: null })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. 194R Source-2 — cumulation, DELIVERED-only basis, RETURNED/PENDING exclusion
//    (real TdsService.compute194R over mocked Prisma; only Source-2 populated)
// ═══════════════════════════════════════════════════════════════════════════════
describe('C. compute194R Source-2 — RedemptionOrder.valuePaise cumulation', () => {
  const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };
  const mockPrisma = {
    creditPayoutEntry: { findMany: jest.fn() },
    creditField: { findMany: jest.fn() },
    outlet: { findMany: jest.fn() },
    channelPartner: { findMany: jest.fn() },
    redemptionOrder: { findMany: jest.fn() },
    tdsOffPlatformEntry: { findMany: jest.fn() },
    tdsDeposit: { findMany: jest.fn() },
  };
  let service: TdsService;
  const CLIENT = 'deoleo';
  const FY = '2025-26';

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TdsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
      ],
    }).compile();
    service = mod.get(TdsService);
    // Only Source-2 populated — silence the other sources.
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeposit.findMany.mockResolvedValue([]);
  });

  it('the Source-2 query is DELIVERED + valuePaise-not-null (excludes PENDING/RETURNED/CANCELLED)', async () => {
    await service.compute194R(CLIENT, FY);
    const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('DELIVERED');           // PENDING / CONFIRMED / RETURNED / CANCELLED excluded
    expect(where.valuePaise).toEqual({ not: null });  // unfrozen orders excluded
    expect(where.partner).toEqual({ clientId: CLIENT });
    expect(where.deliveredAt).toBeDefined();          // FY-windowed
  });

  it('MULTIPLE delivered orders for the SAME PAN cumulate into one PAN row', async () => {
    // Three delivered gifts (incl. a qty>1 whose frozen value is already ×qty) to one outlet.
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 1_000_000n, partner: { panNumber: 'AAAAA1111A' } }, // ₹10,000
      { valuePaise: 600_000n, partner: { panNumber: 'aaaaa1111a' } },   // ₹6,000 (case-insensitive same PAN)
      { valuePaise: 900_000n, partner: { panNumber: 'AAAAA1111A' } },   // ₹9,000 (e.g. 3×₹3,000 gift)
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows).toHaveLength(1);
    expect(rows[0].panNumber).toBe('AAAAA1111A');
    expect(rows[0].baseFyTotalPaise).toBe(2_500_000n); // ₹25,000 combined
    // Above ₹20,000 threshold → 10/90 gross-up: 2500000×10/90 = 277777.7 → rupee-round → 277800.
    expect(rows[0].liabilityPaise).toBe(277800n);
  });

  it('a RETURNED order (zeroed value, RETURNED status) does NOT count — only its DELIVERED sibling does', async () => {
    // The service query already excludes RETURNED by status; even if a zeroed row leaked in,
    // it adds 0. Model the real post-query set: only the DELIVERED sibling is returned.
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 2_100_000n, partner: { panNumber: 'BBBBB2222B' } }, // the kept DELIVERED order
      // (the RETURNED order is filtered out by status:'DELIVERED' and would add 0n anyway)
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows[0].baseFyTotalPaise).toBe(2_100_000n); // the returned one contributed nothing
  });

  it('a DELIVERED FREE_AMOUNT voucher contributes its REAL redeemed value (fallback), not 0', async () => {
    // FREE_AMOUNT has a null snapshot → confirm froze valuePaise = points÷rate (its real value).
    // Once DELIVERED it is a genuine benefit to the outlet and MUST count toward 194R.
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 2_500_000n, partner: { panNumber: 'CCCCC3333C' } }, // ₹25,000 chosen-value voucher
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows[0].baseFyTotalPaise).toBe(2_500_000n);
    expect(rows[0].liabilityPaise).toBeGreaterThan(0n); // it is NOT excluded / zeroed
  });

  it('mixed PANs — vendor-sourced and platform-sourced gifts feed the SAME per-PAN base', async () => {
    // Source is invisible to 194R: both a platform gift and a vendor gift are just
    // RedemptionOrder.valuePaise keyed by the receiving outlet's PAN.
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 2_100_000n, partner: { panNumber: 'DDDDD4444D' } }, // platform gift
      { valuePaise: 2_400_000n, partner: { panNumber: 'EEEEE5555E' } }, // vendor gift, different outlet
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    const byPan = Object.fromEntries(rows.map((r) => [r.panNumber, r.baseFyTotalPaise]));
    expect(byPan['DDDDD4444D']).toBe(2_100_000n);
    expect(byPan['EEEEE5555E']).toBe(2_400_000n);
  });

  it('a null-PAN delivered gift lands in the __NO_PAN__ bucket at 20% (no silent drop)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 2_100_000n, partner: { panNumber: null } },
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows[0].panNumber).toBe('__NO_PAN__');
    // 20/80 gross-up on ₹21,000 → 2100000×20/80 = 525000.
    expect(rows[0].liabilityPaise).toBe(525000n);
  });

  it('below-threshold single delivered gift → liability 0 (₹20,000 is strictly-greater)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { valuePaise: 2_000_000n, partner: { panNumber: 'FFFFF6666F' } }, // exactly ₹20,000
    ]);
    const rows = await service.compute194R(CLIENT, FY);
    expect(rows[0].baseFyTotalPaise).toBe(2_000_000n);
    expect(rows[0].liabilityPaise).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. BigInt paise serialisation — lossless JSON for API responses (main.ts toJSON)
// ═══════════════════════════════════════════════════════════════════════════════
describe('D. BigInt.prototype.toJSON — paise serialise losslessly', () => {
  // Mirror the bootstrap shim (main.ts) so the assertion is self-contained.
  beforeAll(() => {
    (BigInt.prototype as unknown as { toJSON?: () => number }).toJSON = function () {
      return Number(this);
    };
  });

  it('a frozen valuePaise serialises to a plain number (no throw, no "n" suffix)', () => {
    const v = computeFrozenValuePaise({
      isCashMode: false, sellingValuePaiseSnapshot: 12345, quantity: 7, points: 0, rateCenti: 100,
    });
    const json = JSON.stringify({ valuePaise: v });
    expect(json).toBe('{"valuePaise":86415}');
  });

  it('a large-but-realistic paise value (₹90 crore) is lossless through JSON', () => {
    const v = 9_000_000_000n; // ₹9,00,00,000 in paise
    expect(JSON.parse(JSON.stringify({ v })).v).toBe(9_000_000_000);
  });
});
