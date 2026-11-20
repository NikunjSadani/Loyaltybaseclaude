import { belowZeroOfRows, pointsOutcome, rejectedPointsOutcome, storedPointsSplit } from './points-reversal-outcome';

const v2 = (x: Partial<Parameters<typeof pointsOutcome>[0]>) => ({
  reversed: 0, recovered: 0, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, belowZero: 0, shortfall: 0, ...x,
});

describe('POINTS reversal outcome summary — what the BALANCE did (owner 2026-11-19, fix round 3 A5)', () => {
  it('V2 over-reversal: the owner\'s staging example — 7,014 taken, 2,986 recorded as debt, nothing written off', () => {
    const o = pointsOutcome(v2({ reversed: 10000, recovered: 7014, owed: 2986, belowZero: 2986 }));
    expect(o.headline).toBe(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
    );
    expect(o.taken).toBe(7014);
    expect(o.lines).toEqual(['7,014 taken from the wallet', '2,986 recorded as debt, repaid from future earnings']);
  });

  it('V2 fully covered by the wallet: only "taken from the wallet"', () => {
    expect(pointsOutcome(v2({ reversed: 500, recovered: 500 })).headline).toBe('Approved · 500 pts reversed · 500 taken from the wallet');
  });

  it('V2 with the credit\'s own points already expired: "X already expired — nothing to recover"', () => {
    expect(pointsOutcome(v2({ reversed: 10000, alreadyExpired: 10000 })).headline).toBe(
      'Approved · 10,000 pts reversed · 10,000 already expired — nothing to recover',
    );
    expect(pointsOutcome(v2({ reversed: 10000, recovered: 2000, owed: 5000, alreadyExpired: 3000, belowZero: 5000 })).headline).toBe(
      'Approved · 10,000 pts reversed · 2,000 taken from the wallet · 3,000 already expired — nothing to recover · 5,000 recorded as debt, repaid from future earnings',
    );
  });

  it('R1: the debt a credit had paid off comes back — owed because the balance went below zero, and the reason is named', () => {
    expect(pointsOutcome(v2({ reversed: 500, debtRestored: 500, belowZero: 500 })).headline).toBe(
      'Approved · 500 pts reversed · 500 owed (balance below zero), repaid from future earnings — 500 of earlier debt this credit had paid off is owed again',
    );
  });

  it('A5: debt restored while the balance stays ≥ 0 is never called "owed"', () => {
    const o = pointsOutcome(v2({ reversed: 100, recovered: 60, debtRestored: 40, belowZero: 0 }));
    expect(o.headline).toBe(
      'Approved · 100 pts reversed · 100 taken from the wallet · incl. 40 of earlier debt this credit had paid off (restored; the balance stays at or above zero)',
    );
    expect(o.headline).not.toMatch(/owed/);
  });

  it('A4: points taken that were covering earlier debt — the balance went below zero by them, said so', () => {
    expect(pointsOutcome(v2({ reversed: 100, recovered: 100, debtExposed: 40, belowZero: 40 })).headline).toBe(
      'Approved · 100 pts reversed · 60 taken from the wallet · 40 owed (balance below zero), repaid from future earnings — 40 of the points taken were covering earlier debt',
    );
  });

  it('LEGACY (Deoleo — its own rule): floor 0, the rest written off, never called debt', () => {
    const o = pointsOutcome(v2({ reversed: 10000, recovered: 7014, shortfall: 2986 }));
    expect(o.headline).toBe(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 not recovered — already redeemed or expired, written off',
    );
    expect(o.headline).not.toMatch(/debt/);
  });

  it('partial approval, zero approval and rejection', () => {
    expect(pointsOutcome(v2({ reversed: 120, recovered: 120 }), { requested: 300 }).headline).toBe(
      'Partially approved (300 pts requested) · 120 pts reversed · 120 taken from the wallet',
    );
    expect(pointsOutcome(v2({ reversed: 0 })).headline).toBe('Approved · 0 pts reversed — the wallet is unchanged');
    expect(rejectedPointsOutcome().headline).toBe('Rejected · nothing was reversed — the wallet is unchanged');
  });

  it('belowZeroOfRows: per row, how much further below zero (telescopes per wallet)', () => {
    expect(belowZeroOfRows([{ balanceBefore: 7014, balanceAfter: -2986 }])).toBe(2986);
    expect(belowZeroOfRows([{ balanceBefore: 50, balanceAfter: -50 }, { balanceBefore: -50, balanceAfter: -200 }])).toBe(200);
    expect(belowZeroOfRows([{ balanceBefore: 500, balanceAfter: 100 }])).toBe(0);
  });

  it('A7: stored reversals use allocation rows ONLY when every row was written by V2; LEGACY / backfill / pre-column rows keep the reversal\'s own figures', () => {
    const rows = [{ balanceBefore: 7014, balanceAfter: -2986 }];
    expect(
      storedPointsSplit({ approvedPaise: 10000n, shortfallPaise: 0n }, [
        { requested: 10000, debtRestored: 0, recovered: 7014, owed: 2986, shortfall: 0, engineSource: 'V2' },
      ], rows),
    ).toMatchObject({ reversed: 10000, recovered: 7014, owed: 2986, belowZero: 2986, shortfall: 0 });
    // backfilled history with owed > 0 on a LEGACY tenant: no debt, no shrinking "Reversed" — its own figures
    expect(
      storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 100n }, [
        { requested: 500, debtRestored: 0, recovered: 100, owed: 300, shortfall: 100, engineSource: 'BACKFILL' },
      ]),
    ).toEqual({ reversed: 500, recovered: 400, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, belowZero: 0, shortfall: 100 });
    expect(
      storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 400n }, [
        { requested: 500, debtRestored: 0, recovered: 100, owed: 0, shortfall: 400, engineSource: 'LEGACY' },
      ]),
    ).toMatchObject({ recovered: 100, owed: 0, belowZero: 0, shortfall: 400 });
    expect(storedPointsSplit({ approvedPaise: 500n, shortfallPaise: 400n }, [])).toMatchObject({ recovered: 100, shortfall: 400 });
  });
});
