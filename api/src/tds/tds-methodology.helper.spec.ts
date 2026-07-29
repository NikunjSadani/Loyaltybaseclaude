import { TdsSection } from '@prisma/client';
import {
  deriveFrozenSection,
  computeDeduction,
  computeGrossUpTdsInvoiceBasePaise,
  proRataRecovery,
  allocateProRataRecovery,
} from './tds-methodology.helper';
import { rate194C, rate194R } from './tds.helpers';

describe('tds-methodology.helper', () => {
  // ─── deriveFrozenSection ────────────────────────────────────────────────────
  describe('deriveFrozenSection', () => {
    it('INCENTIVE is always 194R regardless of tenant section', () => {
      expect(deriveFrozenSection('INCENTIVE', TdsSection.SEC_194C)).toBe(TdsSection.SEC_194R);
      expect(deriveFrozenSection('INCENTIVE', TdsSection.SEC_194R)).toBe(TdsSection.SEC_194R);
    });

    it('VISIBILITY follows the tenant configured section', () => {
      expect(deriveFrozenSection('VISIBILITY', TdsSection.SEC_194C)).toBe(TdsSection.SEC_194C);
      expect(deriveFrozenSection('VISIBILITY', TdsSection.SEC_194R)).toBe(TdsSection.SEC_194R);
    });
  });

  // ─── computeDeduction (DEDUCT withholding + carry-forward) ───────────────────
  describe('computeDeduction', () => {
    const rate = rate194C(true, 'COMPANY'); // 2/98 → 2% withholding

    it('is zero below threshold (nothing due, nothing carried)', () => {
      const r = computeDeduction({
        cumulativeBasePaise: 5_000_000n, // ₹50,000 base
        priorDeductedPaise: 0n,
        thisPayoutPaise: 5_000_000n,
        rate,
        thresholdMetOnCumulative: false,
      });
      expect(r.tdsDueCumulativePaise).toBe(0n);
      expect(r.tdsDeductThisPaise).toBe(0n);
      expect(r.carryForwardPaise).toBe(0n);
    });

    it('AT threshold withholds 2% of the cumulative base from this payout', () => {
      // ₹1,00,001 cumulative, 2% = ₹2,000.02 → rounded to ₹2,000 = 200,000 paise.
      const r = computeDeduction({
        cumulativeBasePaise: 10_000_100n,
        priorDeductedPaise: 0n,
        thisPayoutPaise: 10_000_100n,
        rate,
        thresholdMetOnCumulative: true,
      });
      expect(r.tdsDueCumulativePaise).toBe(200_000n); // ₹2,000
      expect(r.tdsDeductThisPaise).toBe(200_000n);
      expect(r.carryForwardPaise).toBe(0n);
    });

    it('OVER threshold nets the retroactive jump against prior deductions (catch-up)', () => {
      // Cumulative ₹2,00,000 → due 2% = ₹4,000 = 400,000 paise; ₹1,500 already deducted.
      const r = computeDeduction({
        cumulativeBasePaise: 20_000_000n,
        priorDeductedPaise: 150_000n, // ₹1,500 already withheld
        thisPayoutPaise: 10_000_000n, // ₹1,00,000 payout — big enough to cover the catch-up
        rate,
        thresholdMetOnCumulative: true,
      });
      expect(r.tdsDueCumulativePaise).toBe(400_000n); // ₹4,000
      expect(r.tdsDeductThisPaise).toBe(250_000n); // ₹4,000 − ₹1,500 = ₹2,500
      expect(r.carryForwardPaise).toBe(0n);
    });

    it('carries the un-withheld catch-up forward when the payout is too small', () => {
      // Due ₹4,000, none prior, but this payout is only ₹1,000 → withhold ₹1,000, carry ₹3,000.
      const r = computeDeduction({
        cumulativeBasePaise: 20_000_000n,
        priorDeductedPaise: 0n,
        thisPayoutPaise: 100_000n, // ₹1,000 payout
        rate,
        thresholdMetOnCumulative: true,
      });
      expect(r.tdsDueCumulativePaise).toBe(400_000n);
      expect(r.tdsDeductThisPaise).toBe(100_000n); // capped at the payout
      expect(r.carryForwardPaise).toBe(300_000n); // ₹3,000 carried
    });

    it('carry-forward reconciles across multiple events (prior = running sum deducted)', () => {
      const rate10 = rate194R(true); // 10/90 → 10% withholding
      // Event 1: cumulative ₹1,00,000 crosses threshold. Due 10% = ₹10,000 = 1,000,000 paise.
      // Payout is only ₹4,000 → withhold ₹4,000, carry ₹6,000.
      const e1 = computeDeduction({
        cumulativeBasePaise: 10_000_000n,
        priorDeductedPaise: 0n,
        thisPayoutPaise: 400_000n,
        rate: rate10,
        thresholdMetOnCumulative: true,
      });
      expect(e1.tdsDueCumulativePaise).toBe(1_000_000n);
      expect(e1.tdsDeductThisPaise).toBe(400_000n);
      expect(e1.carryForwardPaise).toBe(600_000n);

      // Event 2: cumulative unchanged (base ₹1,00,000), a fresh ₹8,000 payout.
      // Prior deducted so far = ₹4,000. Catch-up = ₹10,000 − ₹4,000 = ₹6,000; payout ₹8,000 covers it.
      const priorAfterE1 = e1.tdsDeductThisPaise; // 400,000
      const e2 = computeDeduction({
        cumulativeBasePaise: 10_000_000n,
        priorDeductedPaise: priorAfterE1,
        thisPayoutPaise: 800_000n,
        rate: rate10,
        thresholdMetOnCumulative: true,
      });
      expect(e2.tdsDeductThisPaise).toBe(600_000n); // clears the carry
      expect(e2.carryForwardPaise).toBe(0n);

      // Total withheld across events == full liability on the cumulative base.
      expect(priorAfterE1 + e2.tdsDeductThisPaise).toBe(1_000_000n);
    });

    it('never goes negative when prior already exceeds the due (over-deducted)', () => {
      const r = computeDeduction({
        cumulativeBasePaise: 10_000_000n,
        priorDeductedPaise: 1_500_000n, // ₹15,000 already withheld, > ₹10,000 due
        thisPayoutPaise: 500_000n,
        rate: rate194R(true),
        thresholdMetOnCumulative: true,
      });
      expect(r.tdsDeductThisPaise).toBe(0n);
      expect(r.carryForwardPaise).toBe(0n);
    });
  });

  // ─── computeGrossUpTdsInvoiceBasePaise ───────────────────────────────────────
  describe('computeGrossUpTdsInvoiceBasePaise', () => {
    it('is zero below threshold', () => {
      expect(
        computeGrossUpTdsInvoiceBasePaise(10_000_000n, rate194C(true, 'COMPANY'), false),
      ).toBe(0n);
    });

    it('is the grossed-up TDS (base × num/den) at/over threshold', () => {
      // 2/98 gross-up on ₹1,00,000 = 100,000 × 2 / 98 = 2040.81… → round ₹2,041 = 204,100 paise.
      // grossUpTdsPaise: 10_000_000 × 2 = 20_000_000; /98 = 204,081 paise; round-to-rupee → 204,100.
      expect(
        computeGrossUpTdsInvoiceBasePaise(10_000_000n, rate194C(true, 'COMPANY'), true),
      ).toBe(204_100n);
    });
  });

  // ─── proRataRecovery (standalone single share) ───────────────────────────────
  describe('proRataRecovery', () => {
    it('rounds one tenant share = total × base / panBase (half-up)', () => {
      // total ₹1,000 = 100,000 paise; tenant base 1/3 of pan base → 33,333.33 → 33,333.
      expect(
        proRataRecovery({ panTdsTotalPaise: 100_000n, tenantBasePaise: 100n, panBasePaise: 300n }),
      ).toBe(33_333n);
    });

    it('guards panBase = 0 → 0 (no divide-by-zero)', () => {
      expect(
        proRataRecovery({ panTdsTotalPaise: 100_000n, tenantBasePaise: 100n, panBasePaise: 0n }),
      ).toBe(0n);
    });
  });

  // ─── allocateProRataRecovery (EXACT-summing split) ───────────────────────────
  describe('allocateProRataRecovery', () => {
    it('splits exactly across 3 tenants with a rounding remainder (sums to the total)', () => {
      // total 100 paise, equal thirds → 33.33 each; largest-remainder gives 34/33/33.
      const out = allocateProRataRecovery({
        panTdsTotalPaise: 100n,
        tenants: [
          { clientId: 'a', basePaise: 100n },
          { clientId: 'b', basePaise: 100n },
          { clientId: 'c', basePaise: 100n },
        ],
      });
      const sum = out.reduce((s, r) => s + r.tenantSharePaise, 0n);
      expect(sum).toBe(100n);
      // All remainders equal → tie-break by input order: 'a' gets the extra paise.
      expect(out.map((r) => r.tenantSharePaise)).toEqual([34n, 33n, 33n]);
    });

    it('sums EXACTLY to the total for an uneven-base 3-tenant split', () => {
      const total = 1_000_003n;
      const out = allocateProRataRecovery({
        panTdsTotalPaise: total,
        tenants: [
          { clientId: 'a', basePaise: 333_333n },
          { clientId: 'b', basePaise: 333_333n },
          { clientId: 'c', basePaise: 333_334n },
        ],
      });
      const sum = out.reduce((s, r) => s + r.tenantSharePaise, 0n);
      expect(sum).toBe(total);
      // Largest base ('c') should get at least its floor; no share negative.
      for (const r of out) expect(r.tenantSharePaise >= 0n).toBe(true);
    });

    it('gives everyone 0 when panBase = 0 (all-zero bases)', () => {
      const out = allocateProRataRecovery({
        panTdsTotalPaise: 100n,
        tenants: [
          { clientId: 'a', basePaise: 0n },
          { clientId: 'b', basePaise: 0n },
        ],
      });
      expect(out).toEqual([
        { clientId: 'a', tenantSharePaise: 0n },
        { clientId: 'b', tenantSharePaise: 0n },
      ]);
    });

    it('a single tenant receives the whole total', () => {
      const out = allocateProRataRecovery({
        panTdsTotalPaise: 777_777n,
        tenants: [{ clientId: 'solo', basePaise: 12_345n }],
      });
      expect(out).toEqual([{ clientId: 'solo', tenantSharePaise: 777_777n }]);
    });
  });
});
