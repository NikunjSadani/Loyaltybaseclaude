import { pointsOutcome, rejectedPointsOutcome, storedPointsSplit } from './points-reversal-outcome';

describe('POINTS reversal outcome summary (plain words — owner 2026-11-19)', () => {
  it('V2 over-reversal: the owner\'s staging example — 7,014 taken, 2,986 recorded as debt, nothing written off', () => {
    const o = pointsOutcome({ reversed: 10000, recovered: 7014, debtRestored: 0, owed: 2986, shortfall: 0 });
    expect(o.headline).toBe(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
    );
    expect(o.summary).toBe('10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings');
    expect(o.lines).toEqual(['7,014 taken from the wallet', '2,986 recorded as debt, repaid from future earnings']);
  });

  it('V2 with the credit\'s own points already expired (owner 2026-11-19): "X already expired — nothing to recover"', () => {
    expect(pointsOutcome({ reversed: 10000, recovered: 0, debtRestored: 0, owed: 0, alreadyExpired: 10000, shortfall: 0 }).headline).toBe(
      'Approved · 10,000 pts reversed · 10,000 already expired — nothing to recover',
    );
    expect(pointsOutcome({ reversed: 10000, recovered: 2000, debtRestored: 0, owed: 5000, alreadyExpired: 3000, shortfall: 0 }).headline).toBe(
      'Approved · 10,000 pts reversed · 2,000 taken from the wallet · 3,000 already expired — nothing to recover · 5,000 recorded as debt, repaid from future earnings',
    );
    expect(
      storedPointsSplit({ approvedPaise: 10000n, shortfallPaise: 0n }, [
        { requested: 10000, debtRestored: 0, recovered: 2000, owed: 5000, alreadyExpired: 3000, shortfall: 0 },
      ]),
    ).toEqual({ reversed: 10000, recovered: 2000, debtRestored: 0, owed: 5000, alreadyExpired: 3000, shortfall: 0 });
  });

  it('V2 fully covered by the wallet: only "taken from the wallet"', () => {
    expect(pointsOutcome({ reversed: 500, recovered: 500, debtRestored: 0, owed: 0, shortfall: 0 }).headline).toBe(
      'Approved · 500 pts reversed · 500 taken from the wallet',
    );
  });

  it('V2 on a credit that had repaid debt (R1): the debt it paid off is owed again', () => {
    expect(pointsOutcome({ reversed: 500, recovered: 0, debtRestored: 500, owed: 0, shortfall: 0 }).headline).toBe(
      'Approved · 500 pts reversed · 500 of earlier debt this credit had paid off is owed again',
    );
    expect(pointsOutcome({ reversed: 5000, recovered: 0, debtRestored: 1986, owed: 3014, shortfall: 0 }).headline).toBe(
      'Approved · 5,000 pts reversed · 1,986 of earlier debt this credit had paid off is owed again · 3,014 recorded as debt, repaid from future earnings',
    );
  });

  it('LEGACY (Deoleo — its own rule): floor 0, the rest written off, never called debt', () => {
    const o = pointsOutcome({ reversed: 10000, recovered: 7014, debtRestored: 0, owed: 0, shortfall: 2986 });
    expect(o.headline).toBe(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 not recovered — already redeemed or expired, written off',
    );
    expect(o.headline).not.toMatch(/debt/);
    // nothing left in the wallet at all
    expect(pointsOutcome({ reversed: 300, recovered: 0, debtRestored: 0, owed: 0, shortfall: 300 }).headline).toBe(
      'Approved · 300 pts reversed · 300 not recovered — already redeemed or expired, written off',
    );
  });

  it('partial approval, zero approval and rejection', () => {
    expect(
      pointsOutcome({ reversed: 120, recovered: 120, debtRestored: 0, owed: 0, shortfall: 0 }, { requested: 300 }).headline,
    ).toBe('Partially approved (300 pts requested) · 120 pts reversed · 120 taken from the wallet');
    expect(pointsOutcome({ reversed: 300, recovered: 300, debtRestored: 0, owed: 0, shortfall: 0 }, { requested: 300 }).headline).toBe(
      'Approved · 300 pts reversed · 300 taken from the wallet',
    );
    expect(pointsOutcome({ reversed: 0, recovered: 0, debtRestored: 0, owed: 0, shortfall: 0 }).headline).toBe(
      'Approved · 0 pts reversed — the wallet is unchanged',
    );
    expect(rejectedPointsOutcome().headline).toBe('Rejected · nothing was reversed — the wallet is unchanged');
  });

  it('stored reversals: allocation rows when they cover the approved amount, else approvedPaise / shortfallPaise (history kept as recorded)', () => {
    // V2 after 2026-11-19 (debt)
    expect(
      storedPointsSplit({ approvedPaise: 10000n, shortfallPaise: 0n }, [
        { requested: 10000, debtRestored: 0, recovered: 7014, owed: 2986, shortfall: 0 },
      ]),
    ).toEqual({ reversed: 10000, recovered: 7014, debtRestored: 0, owed: 2986, alreadyExpired: 0, shortfall: 0 });
    // V2 approved BEFORE the rule: its recorded write-off stays a write-off (no history rewrite)
    expect(
      storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 200n }, [
        { requested: 300, debtRestored: 0, recovered: 300, owed: 0, shortfall: 0 },
        { requested: 200, debtRestored: 0, recovered: 0, owed: 0, shortfall: 200 },
      ]),
    ).toEqual({ reversed: 500, recovered: 300, debtRestored: 0, owed: 0, alreadyExpired: 0, shortfall: 200 });
    // LEGACY without allocation rows
    expect(storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 400n }, [])).toEqual({
      reversed: 500, recovered: 100, debtRestored: 0, owed: 0, alreadyExpired: 0, shortfall: 400,
    });
    // rows that don't cover the approved amount (an un-attributed history) → the reversal's own figures
    expect(
      storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 0n }, [
        { requested: 100, debtRestored: 0, recovered: 100, owed: 0, shortfall: 0 },
      ]),
    ).toEqual({ reversed: 500, recovered: 500, debtRestored: 0, owed: 0, alreadyExpired: 0, shortfall: 0 });
  });
});
