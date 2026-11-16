// Policy round B — TDS credits (WALLET-REVERSAL-ENGINE-DESIGN.md §8.1): the pure credit-aware DEDUCT computation
// and the release helper. The full service paths (approve → credit, download → applied, cancel → released) are in
// payout-reversal-v2.spec.ts ("Policy round B").
import { computeDeduction } from '../tds/tds-methodology.helper';
import { toTdsRate } from '../tds/tds.helpers';
import { deductWithCredits, fyLabelOf, maskPan, releaseCreditApplications, type OpenTdsCredit } from './tds-credit';

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
    expect(d.perEntry).toEqual([{ entryId: 'e1', withheldPaise: 30_000n, creditPaise: 20_000n }]);
    expect(d.draws).toEqual([{ tdsCreditId: 'c', payoutEntryId: 'e1', amountPaise: 20_000n }]);
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

  it('tenant scope: another program’s credit is hidden (its deposit is not this tenant’s) → full TDS withheld', () => {
    const d = deductWithCredits(base({ credits: [credit('c', 'deoleo', 40_000n)] }));
    expect(d).toMatchObject({ dueThisPaise: 50_000n, creditAppliedPaise: 0n, withheldThisPaise: 50_000n });
  });

  it('FIFO across credits and entries; the credit follows each entry’s own TDS due; sums exact', () => {
    const d = deductWithCredits(base({
      priorDeductedPaise: 40_000n,
      entries: [{ id: 'e1', amountPaise: 3_000_000n }, { id: 'e2', amountPaise: 2_000_000n }],
      credits: [credit('c1', 'bajaj', 10_000n), credit('c22', 'bajaj', 30_000n)],
    }));
    expect(d.creditAppliedPaise).toBe(40_000n);
    expect(d.perEntry).toEqual([
      { entryId: 'e1', withheldPaise: 6_000n, creditPaise: 24_000n },
      { entryId: 'e2', withheldPaise: 4_000n, creditPaise: 16_000n },
    ]);
    expect(d.draws).toEqual([
      { tdsCreditId: 'c1', payoutEntryId: 'e1', amountPaise: 10_000n },
      { tdsCreditId: 'c22', payoutEntryId: 'e1', amountPaise: 14_000n },
      { tdsCreditId: 'c22', payoutEntryId: 'e2', amountPaise: 16_000n },
    ]);
  });

  it('property: 0 ≤ applied ≤ own outstanding, every share ≥ 0, Σ withheld + applied = TDS due, draws = applied', () => {
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
      }));
      const own = credits.filter((c) => c.clientId === 'bajaj').reduce((s, c) => s + c.amountPaise - c.appliedPaise, 0n);
      expect(d.creditAppliedPaise >= 0n && d.creditAppliedPaise <= own).toBe(true);
      expect(d.withheldThisPaise + d.creditAppliedPaise).toBe(d.dueThisPaise);
      expect(d.dueThisPaise <= thisPayout).toBe(true);
      for (const p of d.perEntry) expect(p.withheldPaise >= 0n && p.creditPaise >= 0n).toBe(true);
      expect(d.perEntry.reduce((s, p) => s + p.withheldPaise, 0n)).toBe(d.withheldThisPaise);
      expect(d.draws.reduce((s, x) => s + x.amountPaise, 0n)).toBe(d.creditAppliedPaise);
      for (const c of credits) {
        const used = d.draws.filter((x) => x.tdsCreditId === c.id).reduce((s, x) => s + x.amountPaise, 0n);
        expect(used <= c.amountPaise - c.appliedPaise).toBe(true);
        if (c.clientId !== 'bajaj') expect(used).toBe(0n);
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
    const r1 = await releaseCreditApplications(tx, ['vb'], 'PAYOUT_FAILED');
    expect(r1).toEqual([{ applicationId: 'a1', tdsCreditId: 'c', payoutEntryId: 'vb', amountPaise: 40_000n }]);
    expect(credits[0].appliedPaise).toBe(0n);
    expect(apps[0]).toMatchObject({ releaseReason: 'PAYOUT_FAILED' });
    expect(await releaseCreditApplications(tx, ['vb'], 'PAYOUT_FAILED')).toEqual([]);
    expect(credits[0].appliedPaise).toBe(0n);
    const none = fakeTx([], credits);
    expect(await releaseCreditApplications(none, ['zz'], 'PAYOUT_FAILED')).toEqual([]);
    expect(none.$executeRaw).not.toHaveBeenCalled();
    none.tdsCreditApplication.findMany.mockClear();
    expect(await releaseCreditApplications(none, [], 'PAYOUT_FAILED')).toEqual([]);
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
