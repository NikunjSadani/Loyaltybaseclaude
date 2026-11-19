// Policy round B — TDS credits (WALLET-REVERSAL-ENGINE-DESIGN.md §8.1): the pure credit-aware DEDUCT computation
// and the release helper. The full service paths (approve → credit, download → applied, cancel → released) are in
// payout-reversal-v2.spec.ts ("Policy round B").
import { computeDeduction } from '../tds/tds-methodology.helper';
import { toTdsRate } from '../tds/tds.helpers';
import {
  deductWithCredits,
  deductorScopeClientId,
  fyLabelOf,
  inDeductorScope,
  maskPan,
  releaseCreditApplications,
  reversalCreditCap,
  tdsAdjustmentNote,
  type OpenTdsCredit,
} from './tds-credit';

const RATE = toTdsRate(1); // 194C individual 1/99
const credit = (id: string, clientId: string, amount: bigint, applied = 0n): OpenTdsCredit => ({
  id, clientId, panNumber: 'ABCDE1234F', section: 'SEC_194C', fyLabel: '2026-27', amountPaise: amount, appliedPaise: applied,
  createdAt: new Date(`2026-11-0${id.length}`),
});
const base = (over: Partial<Parameters<typeof deductWithCredits>[0]> = {}) => ({
  clientId: 'bajaj',
  cumulativeBasePaise: 5_000_000n,
  priorDeductedPaise: 40_000n,
  thisPayoutPaise: 5_000_000n,
  rate: RATE,
  thresholdMetOnCumulative: true,
  entries: [{ id: 'e1', amountPaise: 5_000_000n }],
  credits: [] as OpenTdsCredit[],
  ...over,
});

describe('deductWithCredits (pure)', () => {
  it('no credits → exactly computeDeduction (the pre-round-B path)', () => {
    const d = deductWithCredits(base({ priorDeductedPaise: 0n }));
    const ref = computeDeduction({ cumulativeBasePaise: 5_000_000n, priorDeductedPaise: 0n, thisPayoutPaise: 5_000_000n, rate: RATE, thresholdMetOnCumulative: true });
    expect(d.withheldThisPaise).toBe(ref.tdsDeductThisPaise);
    expect(d.creditAppliedPaise).toBe(0n);
    expect(d.tdsDueCumulativePaise).toBe(ref.tdsDueCumulativePaise);
    expect(d.carryForwardPaise).toBe(ref.carryForwardPaise);
    expect(d.draws).toEqual([]);
  });

  it('owner example: ₹500 due, ₹200 credit → ₹300 withheld, credit consumed', () => {
    // prior ₹200 deposited (the reversed payout), base ₹50,000 → due ₹500.
    const d = deductWithCredits(base({ priorDeductedPaise: 20_000n, credits: [credit('c', 'bajaj', 20_000n)] }));
    expect(d).toMatchObject({ dueThisPaise: 50_000n, creditAppliedPaise: 20_000n, withheldThisPaise: 30_000n });
    expect(d.perEntry).toEqual([{ entryId: 'e1', withheldPaise: 30_000n, creditPaise: 20_000n, otherProgrammePaise: 0n, handBackPaise: 0n }]);
    expect(d.draws).toEqual([{ tdsCreditId: 'c', payoutEntryId: 'e1', amountPaise: 20_000n, otherProgramme: false }]);
  });

  it('credit larger than the TDS due → nothing withheld, the remainder carries forward', () => {
    const d = deductWithCredits(base({ cumulativeBasePaise: 3_100_000n, thisPayoutPaise: 3_100_000n, entries: [{ id: 'e1', amountPaise: 3_100_000n }], credits: [credit('c', 'bajaj', 40_000n)] }));
    expect(d).toMatchObject({ dueThisPaise: 31_000n, creditAppliedPaise: 31_000n, withheldThisPaise: 0n });
  });

  it('below the threshold → no TDS due, the credit is untouched', () => {
    const d = deductWithCredits(base({ thresholdMetOnCumulative: false, credits: [credit('c', 'bajaj', 40_000n)] }));
    expect(d).toMatchObject({ dueThisPaise: 0n, creditAppliedPaise: 0n, withheldThisPaise: 0n });
    expect(d.draws).toEqual([]);
  });

  it('D4: every credit the caller passes (its deductor scope) is usable; another programme’s is tagged', () => {
    // 194C: Deoleo's ₹400 credit on the PAN (its deposit is in the shared ledger) reduces Bajaj's ₹500 due to ₹100.
    const d = deductWithCredits(base({ credits: [credit('c', 'deoleo', 40_000n)] }));
    expect(d).toMatchObject({ dueThisPaise: 50_000n, creditAppliedPaise: 40_000n, otherProgrammePaise: 40_000n, withheldThisPaise: 10_000n });
    expect(d.draws).toEqual([{ tdsCreditId: 'c', payoutEntryId: 'e1', amountPaise: 40_000n, otherProgramme: true }]);
  });

  it('D3 hand-back: deposits beyond what the prior base owes are explained, the withholding is still computeDeduction(ledger)', () => {
    // prior base below the threshold now (priorDue 0) but ₹2,500 already deposited; this payout makes ₹2,500 due again.
    const R = toTdsRate(10);
    const d = deductWithCredits({
      clientId: 'bajaj', cumulativeBasePaise: 2_500_000n, priorDeductedPaise: 250_000n, thisPayoutPaise: 1_500_000n, rate: R,
      thresholdMetOnCumulative: true, entries: [{ id: 'd', amountPaise: 1_500_000n }], credits: [], priorDuePaise: 0n,
    });
    expect(d).toMatchObject({ dueThisPaise: 250_000n, handBackPaise: 250_000n, creditAppliedPaise: 0n, withheldThisPaise: 0n });
    const ref = computeDeduction({ cumulativeBasePaise: 2_500_000n, priorDeductedPaise: 250_000n, thisPayoutPaise: 1_500_000n, rate: R, thresholdMetOnCumulative: true });
    expect(d.withheldThisPaise).toBe(ref.tdsDeductThisPaise);
    // not asked (no reversal on the PAN) → no hand-back figure, identical withholding
    const plain = deductWithCredits({
      clientId: 'bajaj', cumulativeBasePaise: 2_500_000n, priorDeductedPaise: 250_000n, thisPayoutPaise: 1_500_000n, rate: R,
      thresholdMetOnCumulative: true, entries: [{ id: 'd', amountPaise: 1_500_000n }], credits: [],
    });
    expect(plain).toMatchObject({ dueThisPaise: 0n, handBackPaise: 0n, withheldThisPaise: 0n });
  });

  it('FIFO across credits and entries; the credit follows each entry’s own TDS due; sums exact', () => {
    const d = deductWithCredits(base({
      priorDeductedPaise: 40_000n,
      entries: [{ id: 'e1', amountPaise: 3_000_000n }, { id: 'e2', amountPaise: 2_000_000n }],
      credits: [credit('c1', 'bajaj', 10_000n), credit('c22', 'bajaj', 30_000n)],
    }));
    expect(d.creditAppliedPaise).toBe(40_000n);
    expect(d.perEntry).toEqual([
      { entryId: 'e1', withheldPaise: 6_000n, creditPaise: 24_000n, otherProgrammePaise: 0n, handBackPaise: 0n },
      { entryId: 'e2', withheldPaise: 4_000n, creditPaise: 16_000n, otherProgrammePaise: 0n, handBackPaise: 0n },
    ]);
    expect(d.draws).toEqual([
      { tdsCreditId: 'c1', payoutEntryId: 'e1', amountPaise: 10_000n, otherProgramme: false },
      { tdsCreditId: 'c22', payoutEntryId: 'e1', amountPaise: 14_000n, otherProgramme: false },
      { tdsCreditId: 'c22', payoutEntryId: 'e2', amountPaise: 16_000n, otherProgramme: false },
    ]);
  });

  it('property: 0 ≤ applied ≤ outstanding, shares ≥ 0, Σ withheld + applied + hand-back = TDS due, withheld = computeDeduction(ledger)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const entries = Array.from({ length: 1 + rnd(4) }, (_, k) => ({ id: `e${k}`, amountPaise: BigInt(1 + rnd(5_000_000)) }));
      const thisPayout = entries.reduce((s, e) => s + e.amountPaise, 0n);
      const credits = Array.from({ length: rnd(4) }, (_, k) => {
        const amt = BigInt(1 + rnd(80_000));
        return credit(`c${'x'.repeat(k)}`, rnd(3) === 0 ? 'deoleo' : 'bajaj', amt, BigInt(rnd(Number(amt))));
      });
      const d = deductWithCredits(base({
        cumulativeBasePaise: thisPayout + BigInt(rnd(10_000_000)),
        priorDeductedPaise: BigInt(rnd(200_000)),
        thisPayoutPaise: thisPayout,
        thresholdMetOnCumulative: rnd(5) !== 0,
        entries,
        credits,
        priorDuePaise: rnd(2) === 0 ? null : BigInt(rnd(200_000)),
      }));
      const all = credits.reduce((s, c) => s + c.amountPaise - c.appliedPaise, 0n);
      expect(d.creditAppliedPaise >= 0n && d.creditAppliedPaise <= all).toBe(true);
      expect(d.handBackPaise >= 0n).toBe(true);
      expect(d.withheldThisPaise + d.creditAppliedPaise + d.handBackPaise).toBe(d.dueThisPaise);
      expect(d.perEntry.reduce((s, p) => s + p.handBackPaise, 0n)).toBe(d.handBackPaise);
      expect(d.perEntry.reduce((s, p) => s + p.otherProgrammePaise, 0n)).toBe(d.otherProgrammePaise);
      expect(d.dueThisPaise <= thisPayout).toBe(true);
      for (const p of d.perEntry) expect(p.withheldPaise >= 0n && p.creditPaise >= 0n && p.handBackPaise >= 0n).toBe(true);
      expect(d.perEntry.reduce((s, p) => s + p.withheldPaise, 0n)).toBe(d.withheldThisPaise);
      expect(d.draws.reduce((s, x) => s + x.amountPaise, 0n)).toBe(d.creditAppliedPaise);
      for (const c of credits) {
        const used = d.draws.filter((x) => x.tdsCreditId === c.id).reduce((s, x) => s + x.amountPaise, 0n);
        expect(used <= c.amountPaise - c.appliedPaise).toBe(true);
      }
    }
  });
});

describe('releaseCreditApplications', () => {
  function fakeTx(apps: Array<Record<string, any>>, credits: Array<Record<string, any>>) {
    return {
      tdsCreditApplication: {
        findMany: jest.fn(async ({ where }: any) =>
          apps.filter((a) => where.payoutEntryId.in.includes(a.payoutEntryId) && a.releasedAt === null)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const a = apps.find((x) => x.id === where.id && x.releasedAt === null);
          if (!a) return { count: 0 };
          Object.assign(a, data);
          return { count: 1 };
        }),
      },
      $executeRaw: jest.fn(async (_s: TemplateStringsArray, amount: bigint, id: string) => {
        const c = credits.find((x) => x.id === id)!;
        if (c.appliedPaise < amount) return 0;
        c.appliedPaise -= amount;
        return 1;
      }),
    } as any;
  }

  it('gives the credit back exactly once (idempotent); no applications → no writes', async () => {
    const credits = [{ id: 'c', appliedPaise: 40_000n }];
    const apps = [{ id: 'a1', tdsCreditId: 'c', payoutEntryId: 'vb', amountPaise: 40_000n, releasedAt: null }];
    const tx = fakeTx(apps, credits);
    const r1 = await releaseCreditApplications(tx, ['vb'], 'PAYOUT_FAILED', 'bajaj');
    expect(r1).toEqual([{ applicationId: 'a1', tdsCreditId: 'c', payoutEntryId: 'vb', amountPaise: 40_000n }]);
    expect(credits[0].appliedPaise).toBe(0n);
    expect(apps[0]).toMatchObject({ releaseReason: 'PAYOUT_FAILED' });
    expect(await releaseCreditApplications(tx, ['vb'], 'PAYOUT_FAILED', 'bajaj')).toEqual([]);
    expect(credits[0].appliedPaise).toBe(0n);
    const none = fakeTx([], credits);
    expect(await releaseCreditApplications(none, ['zz'], 'PAYOUT_FAILED', 'bajaj')).toEqual([]);
    expect(none.$executeRaw).not.toHaveBeenCalled();
    none.tdsCreditApplication.findMany.mockClear();
    expect(await releaseCreditApplications(none, [], 'PAYOUT_FAILED', 'bajaj')).toEqual([]);
    expect(none.tdsCreditApplication.findMany).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('FY label (IST, Apr→Mar) and PAN mask', () => {
    expect(fyLabelOf('2026-10')).toBe('2026-27');
    expect(fyLabelOf('2027-03')).toBe('2026-27');
    expect(fyLabelOf('2027-04')).toBe('2027-28');
    expect(maskPan('abcde1234f')).toBe('XXXXX1234F');
  });
});

describe('fix round B — pure helpers', () => {
  it('H1 reversalCreditCap: auditor example A ₹15k · B ₹10k (₹2,500) · C ₹10k (₹1,000), reverse B → ₹1,000', () => {
    // after B leaves: A + C = ₹25,000 > ₹20,000 → ₹2,500 due; ₹3,500 deposited; no open credit
    expect(reversalCreditCap(250_000n, { ledgerPaise: 350_000n, outstandingCreditsPaise: 0n, dueRemainingPaise: 250_000n, thresholdMetBefore: true, thresholdMetAfter: true }))
      .toEqual({ creditPaise: 100_000n, coversOtherPayoutsPaise: 150_000n, handBackPaise: 0n });
    // reverse C instead → its own ₹1,000 is all surplus
    expect(reversalCreditCap(100_000n, { ledgerPaise: 350_000n, outstandingCreditsPaise: 0n, dueRemainingPaise: 250_000n, thresholdMetBefore: true, thresholdMetAfter: true }))
      .toEqual({ creditPaise: 100_000n, coversOtherPayoutsPaise: 0n, handBackPaise: 0n });
    // below the threshold after (D3): own ₹0 (no TDS), ₹2,500 surplus → no credit, ₹2,500 handed back
    expect(reversalCreditCap(0n, { ledgerPaise: 250_000n, outstandingCreditsPaise: 0n, dueRemainingPaise: 0n, thresholdMetBefore: true, thresholdMetAfter: false }))
      .toEqual({ creditPaise: 0n, coversOtherPayoutsPaise: 0n, handBackPaise: 250_000n });
    // an open credit already carries part of the surplus → never double counted
    expect(reversalCreditCap(100_000n, { ledgerPaise: 350_000n, outstandingCreditsPaise: 100_000n, dueRemainingPaise: 250_000n, thresholdMetBefore: true, thresholdMetAfter: true }))
      .toEqual({ creditPaise: 0n, coversOtherPayoutsPaise: 100_000n, handBackPaise: 0n });
  });

  it('D4 deductor scope: 194C every tenant, 194R this client only', () => {
    expect(deductorScopeClientId('SEC_194C', 'bajaj')).toBeNull();
    expect(deductorScopeClientId('SEC_194R', 'bajaj')).toBe('bajaj');
    expect(inDeductorScope('SEC_194C', 'bajaj', 'deoleo')).toBe(true);
    expect(inDeductorScope('SEC_194R', 'bajaj', 'deoleo')).toBe(false);
    expect(inDeductorScope('SEC_194R', 'bajaj', 'bajaj')).toBe(true);
  });

  it('one TDS line wording (credit / another programme / hand-back)', () => {
    expect(tdsAdjustmentNote({ duePaise: 50_000n, creditPaise: 40_000n, otherProgrammePaise: 10_000n, handBackPaise: 5_000n })).toBe(
      'TDS due ₹500.00 · ₹50.00 less TDS: adjusted after a reversal brought PAN below the limit · ₹300.00 adjusted from earlier TDS credit · ' +
        '₹100.00 adjusted from earlier TDS credit (another programme) · ₹50.00 withheld from this payout',
    );
  });
});
