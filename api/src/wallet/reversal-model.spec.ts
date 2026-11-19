import {
  checkInvariants,
  credit,
  emptyModel,
  expire,
  HistoricalEvent,
  holdings,
  legacyDebtDebit,
  legacyReversalDecrement,
  ModelEvent,
  Movement,
  replay,
  reversalFloor,
  reverse,
  ReversalModelError,
  run,
  spend,
  WalletModel,
} from './reversal-model';

// ───────────────────────────── helpers ─────────────────────────────

/** Opening balance: negative ⇒ a legacy vendor-import debit from 0 (creates debt); positive ⇒ non-reversible credit. */
function opening(n: number): ModelEvent[] {
  if (n < 0) return [{ type: 'legacyDebit', amount: -n }];
  if (n > 0)
    return [{ type: 'credit', id: 'OPEN', amount: n, reversible: false }];
  return [];
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    const rest = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

interface Outcome {
  model: WalletModel;
  movements: Movement[];
  rev: Movement[];
  /** Σ shortfall — always 0 since owner decision 2026-11-19 (asserted in outcome()) */
  sumShortfall: number;
  /** Σ owed s = r − p − c: booked as debt, repaid from future earnings (owner 2026-11-19) */
  sumOwed: number;
  sumRecovered: number; // p + c
}

function outcome(prefix: ModelEvent[], reversals: ModelEvent[]): Outcome {
  const { model, movements } = run([...prefix, ...reversals]);
  const rev = movements.slice(prefix.length);
  expect(checkInvariants(model)).toEqual([]);
  // owner 2026-11-19: a reversal always removes the whole r from B (p + c + owed = r), nothing is written off
  for (const m of rev) {
    expect(m.shortfall).toBe(0);
    expect(m.debtRestored + m.alreadyExpired + m.recovered + m.owed).toBe(m.pointsRequested);
    expect(m.pointsDelta).toBe(-(m.pointsRequested - m.alreadyExpired) || 0);
    expect(m.debtDelta).toBe(m.debtRestored + m.owed);
  }
  return {
    model,
    movements,
    rev,
    sumShortfall: rev.reduce((s, m) => s + m.shortfall, 0),
    sumOwed: rev.reduce((s, m) => s + m.owed, 0),
    sumRecovered: rev.reduce((s, m) => s + m.debtRestored + m.recovered, 0),
  };
}

function offsets(m: WalletModel): Record<string, [number, number]> {
  const o: Record<string, [number, number]> = {};
  for (const p of Object.values(m.positions)) o[p.id] = [p.offset, p.reversed];
  return o;
}

/** Runs every permutation of `reversals` and asserts the order-free totals; returns the outcomes. */
function allOrders(prefix: ModelEvent[], reversals: ModelEvent[]): Outcome[] {
  const outs = permutations(reversals).map((perm) => outcome(prefix, perm));
  const ref = outs[0];
  for (const o of outs) {
    expect(o.model.state.B).toBe(ref.model.state.B);
    expect(o.model.state.D).toBe(ref.model.state.D);
    expect(offsets(o.model)).toEqual(offsets(ref.model));
    expect(o.sumShortfall).toBe(ref.sumShortfall);
    expect(o.sumOwed).toBe(ref.sumOwed);
    expect(o.sumRecovered).toBe(ref.sumRecovered);
  }
  return outs;
}

const rev = (creditId: string, amount: number): ModelEvent => ({
  type: 'reverse',
  creditId,
  amount,
});
const cr = (id: string, amount: number, reversible = true): ModelEvent => ({
  type: 'credit',
  id,
  amount,
  reversible,
});
const sp = (amount: number): ModelEvent => ({ type: 'spend', amount });

/** mulberry32 — seeded PRNG, no deps. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rnd: () => number, lo: number, hi: number) =>
  lo + Math.floor(rnd() * (hi - lo + 1));

/** Today's behaviour (legacy reference): reversal decrements min(r, max(0,B)) and burns lots FIFO (oldest first). */
function legacyRun(events: ModelEvent[]): {
  B: number[];
  lots: Record<string, number>;
} {
  let B = 0;
  const lots: { id: string; remaining: number }[] = [];
  const Bs: number[] = [];
  const burn = (amt: number) => {
    let left = amt;
    for (const l of lots) {
      const t = Math.min(left, l.remaining);
      l.remaining -= t;
      left -= t;
    }
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'credit':
        B += ev.amount;
        lots.push({ id: ev.id, remaining: ev.amount });
        break;
      case 'spend':
        B -= ev.amount;
        burn(ev.amount);
        break;
      case 'expire': {
        const l = lots.find((x) => x.id === ev.lotId)!;
        const e = Math.min(l.remaining, Math.max(0, B));
        B -= e;
        l.remaining = 0;
        break;
      }
      case 'reverse': {
        const d = legacyReversalDecrement(B, ev.amount);
        B -= d;
        burn(d);
        break;
      }
      case 'legacyDebit':
        throw new Error('legacy reference is for never-negative wallets only');
    }
    Bs.push(B);
  }
  const out: Record<string, number> = {};
  for (const l of lots) out[l.id] = l.remaining;
  return { B: Bs, lots: out };
}

function lotMap(m: WalletModel): Record<string, number> {
  const o: Record<string, number> = {};
  for (const l of m.lots) o[l.id] = l.remaining;
  return o;
}

// ───────────────────────────── transitions ─────────────────────────────

describe('reversal-model transitions (§1.2)', () => {
  it('credit repays debt first (Q12) and records the offset', () => {
    const s = credit(legacyDebtDebit(emptyModel(), 841).model, {
      id: 'X',
      amount: 500,
      reversible: true,
    });
    expect(s.model.state).toEqual({ B: -341, D: 341, seq: 2 });
    expect(s.model.positions.X).toEqual({
      id: 'X',
      amount: 500,
      offset: 500,
      reversed: 0,
      lotRemaining: 0,
    });
    expect(s.movement).toMatchObject({
      pointsDelta: 500,
      debtDelta: -500,
      offsetDelta: 500,
    });
    expect(checkInvariants(s.model)).toEqual([]);
  });

  it('R1: −841, X +500 → reverse X → −841 (floor = −(D + O_X))', () => {
    const m = run([...opening(-841), cr('X', 500)]).model;
    expect(reversalFloor(m, 'X')).toBe(-841);
    const s = reverse(m, 'X', 500);
    expect(s.model.state.B).toBe(-841);
    expect(s.model.state.D).toBe(841);
    expect(s.movement).toMatchObject({
      debtRestored: 500,
      recovered: 0,
      owed: 0,
      shortfall: 0,
      pointsDelta: -500,
    });
  });

  it('owner 2026-11-19 — over-reversal becomes debt: reverse 10,000 from a wallet holding 7,014 → B −2,986, D 2,986, nothing written off', () => {
    const m = run([cr('X', 10000), sp(2986)]).model; // holds 7,014
    expect(m.state).toMatchObject({ B: 7014, D: 0 });
    const s = reverse(m, 'X', 10000);
    expect(s.model.state).toMatchObject({ B: -2986, D: 2986 });
    expect(s.movement).toMatchObject({
      pointsRequested: 10000,
      pointsDelta: -10000,
      debtDelta: 2986,
      debtRestored: 0,
      recovered: 7014,
      owed: 2986,
      shortfall: 0,
      lotDraws: [{ lotId: 'X', points: 7014 }],
    });
    expect(s.model.positions.X).toMatchObject({ offset: 0, reversed: 10000, lotRemaining: 0 });
    expect(checkInvariants(s.model)).toEqual([]);
    expect(holdings(s.model.state)).toBe(0);
    // no redemption while in debt (redeemable < 0)
    expect(() => spend(s.model, 1)).toThrow(ReversalModelError);
    // the next credit repays the debt first: +5,000 → B 2,014, D 0, the new lot holds 2,014 (Q12)
    const c = credit(s.model, { id: 'Y', amount: 5000, reversible: true });
    expect(c.model.state).toMatchObject({ B: 2014, D: 0 });
    expect(c.model.positions.Y).toMatchObject({ offset: 2986, lotRemaining: 2014 });
    expect(checkInvariants(c.model)).toEqual([]);
    // a smaller credit only reduces the debt: +1,000 → B −1,986, D 1,986, nothing spendable
    const c2 = credit(s.model, { id: 'Z', amount: 1000, reversible: true });
    expect(c2.model.state).toMatchObject({ B: -1986, D: 1986 });
    expect(() => spend(c2.model, 1)).toThrow(ReversalModelError);
    // the LEGACY rule (Deoleo) would have floored at 0 and written 2,986 off
    expect(legacyReversalDecrement(7014, 10000)).toBe(7014);
  });

  describe('owner 2026-11-19 — expired points are not recovered twice (the reversed credit\'s own expired points count as recovered)', () => {
    it('auditor example: X 10,000 fully expired, Y 5,000; reverse X 10,000 → nothing taken, no debt, Y untouched', () => {
      const m = run([cr('X', 10000), { type: 'expire', lotId: 'X' }, cr('Y', 5000)]).model;
      expect(m.state).toMatchObject({ B: 5000, D: 0 });
      expect(m.positions.X).toMatchObject({ expired: 10000, lotRemaining: 0 });
      const s = reverse(m, 'X', 10000);
      expect(s.model.state).toMatchObject({ B: 5000, D: 0 });
      expect(s.movement).toMatchObject({
        pointsRequested: 10000, pointsDelta: 0, debtDelta: 0, debtRestored: 0, alreadyExpired: 10000, recovered: 0, owed: 0,
        shortfall: 0, lotDraws: [],
      });
      expect(lotMap(s.model)).toEqual({ X: 0, Y: 5000 });
      expect(s.model.positions.X).toMatchObject({ reversed: 10000, expiredCounted: 10000 });
      expect(checkInvariants(s.model, { neverNegative: true })).toEqual([]);
    });

    it('partly expired: X 10,000 (4,000 redeemed from it, 6,000 expired), Y 5,000; reverse X → 6,000 already expired, 4,000 taken from Y\'s points, no debt', () => {
      const m = run([cr('X', 10000), sp(4000), { type: 'expire', lotId: 'X' }, cr('Y', 5000)]).model;
      expect(m.state).toMatchObject({ B: 5000, D: 0 });
      expect(m.positions.X.expired).toBe(6000);
      const s = reverse(m, 'X', 10000);
      expect(s.movement).toMatchObject({ alreadyExpired: 6000, recovered: 4000, owed: 0, pointsDelta: -4000 });
      expect(s.model.state).toMatchObject({ B: 1000, D: 0 });
      expect(lotMap(s.model)).toEqual({ X: 0, Y: 1000 });
      expect(checkInvariants(s.model)).toEqual([]);
    });

    it('partly expired AND partly spent beyond holdings: X 10,000 (7,000 redeemed, 3,000 expired), Y 2,000; reverse X → 3,000 expired, 2,000 taken, 5,000 debt', () => {
      const m = run([cr('X', 10000), sp(7000), { type: 'expire', lotId: 'X' }, cr('Y', 2000)]).model;
      expect(m.state).toMatchObject({ B: 2000, D: 0 });
      expect(m.positions.X.expired).toBe(3000);
      const s = reverse(m, 'X', 10000);
      expect(s.movement).toMatchObject({ alreadyExpired: 3000, recovered: 2000, owed: 5000, pointsDelta: -7000, debtDelta: 5000 });
      expect(s.model.state).toMatchObject({ B: -5000, D: 5000 });
      expect(checkInvariants(s.model)).toEqual([]);
    });

    it('partial reversals count the expired part first and never twice; every split order gives the same totals', () => {
      const prefix = [cr('X', 10000), sp(3000), { type: 'expire', lotId: 'X' } as ModelEvent, cr('Y', 5000)];
      const outs = allOrders(prefix, [rev('X', 2000), rev('X', 8000)]);
      for (const o of outs) {
        expect(o.rev.reduce((n, mv) => n + mv.alreadyExpired, 0)).toBe(7000);
        expect(o.sumRecovered).toBe(3000);
        expect(o.sumOwed).toBe(0);
        expect(o.model.state).toMatchObject({ B: 2000, D: 0 });
      }
      // a later expiry of what is left is still counted once
      const m2 = run([cr('X', 1000), rev('X', 300), { type: 'expire', lotId: 'X' }]).model; // 300 taken from X's lot, 700 expired
      const s2 = reverse(m2, 'X', 700);
      expect(s2.movement).toMatchObject({ alreadyExpired: 700, recovered: 0, owed: 0, pointsDelta: 0 });
      expect(() => reverse(s2.model, 'X', 1)).toThrow(/cap exceeded/);
    });

    it('a credit that landed on debt and then expired: the debt it repaid comes back (R1), its expired part is not taken again', () => {
      // −500, X +800 (o 500, lot 300), lot X expires (e 300) → B 0, D 0; reverse X 800 → p 500, q 300 → B −500, D 500
      const m = run([...opening(-500), cr('X', 800), { type: 'expire', lotId: 'X' }]).model;
      expect(m.state).toMatchObject({ B: 0, D: 0 });
      const s = reverse(m, 'X', 800);
      expect(s.movement).toMatchObject({ debtRestored: 500, alreadyExpired: 300, recovered: 0, owed: 0, pointsDelta: -500 });
      expect(s.model.state).toMatchObject({ B: -500, D: 500 });
    });
  });

  it('fix round 3 A4: taking holdings that were backing EXISTING debt is recorded (debtExposed) — B 60 / D 40, reverse Y 100 → B −40', () => {
    // −40 (D 40), X +100 (O_X 40, B 60), Y +100 (B 160), reverse X 40 (p 40 → B 120, D 40), redeem 60 → B 60, D 40, H 100
    const m = run([...opening(-40), cr('X', 100), cr('Y', 100), rev('X', 40), sp(60)]).model;
    expect(m.state).toMatchObject({ B: 60, D: 40 });
    const s = reverse(m, 'Y', 100);
    expect(s.model.state).toMatchObject({ B: -40, D: 40 });
    expect(s.movement).toMatchObject({ recovered: 100, owed: 0, debtRestored: 0, debtExposed: 40, shortfall: 0 });
    // a reversal that stays ≥ 0, or whose negative is fully explained by p / owed, exposes nothing
    expect(reverse(run([cr('X', 10000), sp(2986)]).model, 'X', 10000).movement.debtExposed).toBe(0);
    expect(reverse(run([...opening(-841), cr('X', 500)]).model, 'X', 500).movement.debtExposed).toBe(0);
  });

  it('spend is guarded B ≥ s', () => {
    const m = run([cr('X', 100)]).model;
    expect(() => spend(m, 101)).toThrow(ReversalModelError);
    expect(() => spend(run(opening(-5)).model, 1)).toThrow(ReversalModelError);
  });

  it('legacy debit creates debt only beyond holdings', () => {
    const m = run([cr('X', 300), { type: 'legacyDebit', amount: 500 }]).model;
    expect(m.state).toEqual({ B: -200, D: 200, seq: 2 });
    expect(m.positions.X.lotRemaining).toBe(0);
    expect(checkInvariants(m)).toEqual([]);
  });

  it('reversal guards: unknown / non-reversible credit (T-h → 400), cap r ≤ a − ρ, positive integer', () => {
    const m = run([cr('X', 500), cr('M', 100, false)]).model;
    expect(() => reverse(m, 'NOPE', 1)).toThrow(ReversalModelError);
    expect(() => reverse(m, 'M', 1)).toThrow(ReversalModelError);
    expect(() => reverse(m, 'X', 501)).toThrow(ReversalModelError);
    expect(() => reverse(m, 'X', 0)).toThrow(ReversalModelError);
    expect(() => reverse(m, 'X', 1.5)).toThrow(ReversalModelError);
  });

  it('pure: inputs are never mutated', () => {
    const m = run([...opening(-100), cr('X', 300)]).model;
    const snap = JSON.stringify(m);
    reverse(m, 'X', 300);
    spend(m, 100);
    expire(m, 'X');
    legacyDebtDebit(m, 50);
    credit(m, { id: 'Y', amount: 5, reversible: true });
    expect(JSON.stringify(m)).toBe(snap);
  });

  it('reversal consumes the reversed credit OWN lot first, then FIFO (Q7)', () => {
    const m = run([cr('A', 500), cr('X', 300), sp(100)]).model; // A 400, X 300
    const s = reverse(m, 'X', 300);
    expect(s.movement.lotDraws).toEqual([{ lotId: 'X', points: 300 }]);
    expect(lotMap(s.model)).toEqual({ A: 400, X: 0 });
    // own lot partly spent → remainder FIFO
    const m2 = run([cr('X', 300), cr('A', 500), sp(400)]).model; // X 0, A 400
    const s2 = reverse(m2, 'X', 300);
    expect(s2.movement.lotDraws).toEqual([{ lotId: 'A', points: 300 }]);
  });
});

// ───────────────────────────── §6 matrix ─────────────────────────────

describe('§6 test matrix (both / all approval orders)', () => {
  it('T-a: 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 → B −500, D 500, Σrec 300, Σowed 500 (owner 2026-11-19; LEGACY: 0, 500 written off)', () => {
    const prefix = [cr('f1', 500), sp(500), cr('f2', 300)];
    const outs = allOrders(prefix, [rev('f1', 500), rev('f2', 300)]);
    for (const o of outs) {
      expect(o.model.state.B).toBe(-500);
      expect(o.model.state.D).toBe(500);
      expect(o.sumRecovered).toBe(300);
      expect(o.sumOwed).toBe(500);
      expect(o.sumShortfall).toBe(0);
      // LEGACY (floor 0) would end at 0 with the 500 written off — V2 books it as debt instead
      const today = legacyRun([
        ...prefix,
        ...o.rev.map((m) => rev(m.refId!, m.pointsRequested)),
      ]);
      expect(today.B[today.B.length - 1]).toBe(0);
      expect(o.model.state.B).toBe(today.B[today.B.length - 1] - o.sumOwed);
    }
  });

  it('T-b: −841, f1 +500, f2 +300; reverse f1, f2 → B −841, sf 0', () => {
    const outs = allOrders(
      [...opening(-841), cr('f1', 500), cr('f2', 300)],
      [rev('f1', 500), rev('f2', 300)],
    );
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -841, D: 841 });
      expect(o.sumOwed).toBe(0);
    }
  });

  it('T-c: −100, E +500, redeem 400, X +300; reverse E, X → B −500, D 500, Σrec 400, Σowed 400', () => {
    const prefix = [...opening(-100), cr('E', 500), sp(400), cr('X', 300)];
    const outs = allOrders(prefix, [rev('E', 500), rev('X', 300)]);
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -500, D: 500 });
      expect(o.sumRecovered).toBe(400);
      expect(o.sumOwed).toBe(400);
    }
    // Q2: attribution is first-approved-first (order-dependent per reversal, order-free in total)
    const [eFirst, xFirst] = outs;
    expect(eFirst.rev.map((m) => m.owed)).toEqual([100, 300]);
    expect(xFirst.rev.map((m) => m.owed)).toEqual([0, 400]);
  });

  it('T-d: −1000, D +1200, E +500, reverse D, X +300; reverse E & X → B −1000, sf 0 (HEAD −700 vs −1000)', () => {
    const prefix = [
      ...opening(-1000),
      cr('D', 1200),
      cr('E', 500),
      rev('D', 1200),
      cr('X', 300),
    ];
    const mid = run(prefix).model;
    expect(mid.state).toMatchObject({ B: -200, D: 700 });
    expect(mid.positions.X.offset).toBe(300);
    expect(mid.positions.E.offset).toBe(0);
    const outs = allOrders(prefix, [rev('E', 500), rev('X', 300)]);
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -1000, D: 1000 });
      expect(o.sumOwed).toBe(0);
    }
  });

  it('T-R2*: −100, X +100, Z +200, redeem 200, Y +200; reverse X & Y → B −100 (R2 refinement, Q1)', () => {
    const prefix = [
      ...opening(-100),
      cr('X', 100),
      cr('Z', 200),
      sp(200),
      cr('Y', 200),
    ];
    expect(run(prefix).model.state).toMatchObject({ B: 200, D: 0 });
    const outs = allOrders(prefix, [rev('X', 100), rev('Y', 200)]);
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -100, D: 100 });
      expect(o.sumOwed).toBe(0);
    }
    // the refinement: Y-then-X takes a wallet at 0 down to −100 (today would stop at 0) — never below restored debt
    const yThenX = outs[1];
    expect(yThenX.rev.map((m) => m.pointsDelta)).toEqual([-200, -100]);
    // reversing Z too (all 3, every order): Z's 200 were already spent → owed, booked as debt (owner 2026-11-19)
    const outs3 = allOrders(prefix, [
      rev('X', 100),
      rev('Y', 200),
      rev('Z', 200),
    ]);
    expect(outs3[0].model.state).toMatchObject({ B: -300, D: 300 });
    expect(outs3[0].sumOwed).toBe(200);
  });

  it('T-g1: partial reversal cap enforced (Σ ≤ a)', () => {
    const m1 = reverse(run([cr('X', 500)]).model, 'X', 300).model;
    expect(() => reverse(m1, 'X', 201)).toThrow(/cap exceeded/);
    const m2 = reverse(m1, 'X', 200).model;
    expect(m2.positions.X.reversed).toBe(500);
    expect(() => reverse(m2, 'X', 1)).toThrow(/cap exceeded/);
    expect(m2.state.B).toBe(0);
  });

  it('T-g2: −200, X +500, redeem 100; reverse X 150 & X 350 → B −300, D 300, Σowed 100 both orders', () => {
    const outs = allOrders(
      [...opening(-200), cr('X', 500), sp(100)],
      [rev('X', 150), rev('X', 350)],
    );
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -300, D: 300 });
      expect(o.model.positions.X).toMatchObject({ offset: 0, reversed: 500 });
      expect(o.sumOwed).toBe(100);
    }
  });

  it('T-g3: −300, X +200, Y +400, redeem 100; reverse X 100, Y 250, X 100 (all 6 orders) → B −250, D 300, sf 0', () => {
    const outs = allOrders(
      [...opening(-300), cr('X', 200), cr('Y', 400), sp(100)],
      [rev('X', 100), rev('Y', 250), rev('X', 100)],
    );
    expect(outs).toHaveLength(6);
    for (const o of outs) {
      expect(o.model.state).toMatchObject({ B: -250, D: 300 });
      expect(o.model.positions.X).toMatchObject({ offset: 0, reversed: 200 });
      expect(o.model.positions.Y).toMatchObject({ offset: 0, reversed: 250 });
      expect(o.sumOwed).toBe(0);
    }
  });

  it('T-x1: expiry with debt = today’s clamp; the excess is reclassified as debt repayment (Q6)', () => {
    // (1) B < 0 while the lot still has points: nothing expires from B, the whole lot repays debt.
    const prefix = [
      ...opening(-1000),
      cr('D', 1200),
      cr('E', 500),
      rev('D', 1200),
    ];
    const before = run(prefix).model;
    expect(before.state).toMatchObject({ B: -500, D: 1000 });
    const s = expire(before, 'E');
    expect(s.movement).toMatchObject({
      pointsDelta: 0,
      debtDelta: -500,
      offsetDelta: 500,
      offsetPositionId: 'E',
    });
    expect(s.movement.pointsDelta).toBe(
      0 - legacyReversalDecrement(before.state.B, 500),
    ); // = clamp min(h, max(0,B))
    expect(s.model.state).toMatchObject({ B: -500, D: 500 });
    expect(s.model.positions.E).toMatchObject({ offset: 500, lotRemaining: 0 });
    expect(checkInvariants(s.model)).toEqual([]);
    const after = reverse(s.model, 'E', 500);
    expect(after.model.state).toMatchObject({ B: -1000, D: 1000 });
    expect(after.movement).toMatchObject({
      debtRestored: 500,
      recovered: 0,
      owed: 0,
      shortfall: 0,
    });

    // (2) 0 < B < h: e = B (clamp), excess h − B repays debt.
    const m2 = run([
      ...opening(-100),
      cr('E', 500),
      cr('X', 300),
      rev('E', 500),
    ]).model;
    expect(m2.state).toMatchObject({ B: 200, D: 100 });
    const s2 = expire(m2, 'X');
    expect(s2.movement).toMatchObject({
      pointsDelta: -200,
      debtDelta: -100,
      offsetDelta: 100,
    });
    expect(s2.model.state).toMatchObject({ B: 0, D: 0 });
    const r2 = reverse(s2.model, 'X', 300);
    // owner 2026-11-19: X's 200 that expired count as already recovered — not taken again, not owed
    expect(r2.model.state).toMatchObject({ B: -100, D: 100 });
    expect(r2.movement).toMatchObject({
      debtRestored: 100,
      alreadyExpired: 200,
      recovered: 0,
      owed: 0,
      shortfall: 0,
    });
  });

  describe('DE-1..8 positive histories (D = 0): identical to LEGACY while the wallet still holds the points; an over-reversal becomes debt (owner 2026-11-19)', () => {
    const cases: [string, ModelEvent[], number, number, number][] = [
      // id, events, final B, final D, Σ owed (LEGACY wrote Σ owed off as shortfall and ended Σ owed higher)
      ['DE-1 credit, full reversal', [cr('X', 500), rev('X', 500)], 0, 0, 0],
      [
        'DE-2 credit, partial spend, full reversal',
        [cr('X', 500), sp(200), rev('X', 500)],
        -200,
        200,
        200,
      ],
      [
        'DE-3 two credits, reverse the older',
        [cr('X', 500), cr('Y', 300), rev('X', 500)],
        300,
        0,
        0,
      ],
      [
        'DE-5 fully spent, reversal, later credit (the credit repays the debt first)',
        [cr('X', 500), sp(500), rev('X', 500), cr('Y', 200)],
        -300,
        300,
        500,
      ],
      [
        'DE-6 opening balance expires, then reversal',
        [
          cr('OPEN', 1000, false),
          cr('X', 300),
          { type: 'expire', lotId: 'OPEN' },
          rev('X', 300),
        ],
        0,
        0,
        0,
      ],
      [
        'DE-7 repeated partial reversals around a spend',
        [cr('X', 1000), rev('X', 200), sp(300), rev('X', 300), rev('X', 500)],
        -300,
        300,
        300,
      ],
      [
        'DE-8 manual + credit, all spent, reversal',
        [cr('M', 400, false), cr('X', 600), sp(1000), rev('X', 600)],
        -600,
        600,
        600,
      ],
    ];
    it.each(cases)('%s', (_id, events, finalB, finalD, owed) => {
      const { model, movements } = run(events);
      const today = legacyRun(events);
      expect(model.state.B).toBe(finalB);
      expect(model.state.D).toBe(finalD);
      expect(movements.reduce((s, m) => s + m.shortfall, 0)).toBe(0);
      expect(movements.reduce((s, m) => s + m.owed, 0)).toBe(owed);
      // V2 = LEGACY minus the owed part (LEGACY floored at 0 and wrote it off)
      expect(model.state.B).toBe(today.B[today.B.length - 1] - owed);
      if (owed === 0) {
        // nothing owed → balance after every step and the lots == LEGACY (Deoleo parity)
        let B = 0;
        const v2B = movements.map((m) => (B += m.pointsDelta));
        expect(v2B).toEqual(today.B);
        expect(lotMap(model)).toEqual(today.lots);
        expect(checkInvariants(model, { neverNegative: true })).toEqual([]);
      } else {
        expect(checkInvariants(model)).toEqual([]);
        expect(holdings(model.state)).toBe(Object.values(lotMap(model)).reduce((s, n) => s + n, 0));
      }
    });

    it('DE-4 two credits, reverse the newer: B identical; lot fix — X’s own lot is burnt, not the oldest', () => {
      const events = [cr('A', 500), cr('X', 300), rev('X', 300)];
      const { model } = run(events);
      const today = legacyRun(events);
      expect(model.state.B).toBe(today.B[today.B.length - 1]);
      expect(model.state.B).toBe(500);
      expect(lotMap(model)).toEqual({ A: 500, X: 0 });
      expect(today.lots).toEqual({ A: 200, X: 300 }); // today's bug (Q7)
      expect(checkInvariants(model, { neverNegative: true })).toEqual([]);
    });
  });

  it('DE-9 property: random D = 0 histories → v2 recovers min(r, B) (= the LEGACY decrement), owes the rest as debt; I1–I5 hold until the first over-reversal (2,500 cases)', () => {
    const rnd = prng(0xde09);
    let reversalsChecked = 0;
    let overReversals = 0;
    for (let c = 0; c < 2500; c++) {
      let m = emptyModel();
      const steps = randInt(rnd, 3, 25);
      let nid = 0;
      let inDebtSince = false;
      for (let i = 0; i < steps; i++) {
        const roll = rnd();
        const posIds = Object.values(m.positions).filter(
          (p) => p.reversed < p.amount,
        );
        const liveLots = m.lots.filter((l) => l.remaining > 0);
        if (roll < 0.35 || m.lots.length === 0) {
          m = credit(m, {
            id: `c${nid++}`,
            amount: randInt(rnd, 1, 1000),
            reversible: rnd() < 0.8,
          }).model;
        } else if (roll < 0.55 && m.state.B > 0) {
          m = spend(m, randInt(rnd, 1, m.state.B)).model;
        } else if (roll < 0.65 && liveLots.length) {
          m = expire(
            m,
            liveLots[randInt(rnd, 0, liveLots.length - 1)].id,
          ).model;
        } else if (posIds.length) {
          const p = posIds[randInt(rnd, 0, posIds.length - 1)];
          const r = randInt(rnd, 1, p.amount - p.reversed);
          const s = reverse(m, p.id, r);
          // owner 2026-11-19: X's own expired points count as already recovered (q), the rest leaves the balance
          const q = Math.min(r - Math.min(r, p.offset), (p.expired ?? 0) - (p.expiredCounted ?? 0));
          expect(s.movement.alreadyExpired).toBe(q);
          expect(s.movement.pointsDelta).toBe(-(r - q) || 0);
          expect(s.movement.shortfall).toBe(0);
          if (!inDebtSince) {
            // D = 0 and every O = 0: what is taken is the LEGACY floor-0 decrement of the unexpired part
            expect(s.movement.recovered).toBe(legacyReversalDecrement(m.state.B, r - q));
            expect(s.movement.debtRestored).toBe(0);
            expect(s.movement.owed).toBe(r - q - Math.min(r - q, m.state.B));
            reversalsChecked++;
            if (s.movement.owed > 0) {
              overReversals++;
              inDebtSince = true;
            }
          }
          m = s.model;
        }
        const v = checkInvariants(m, { neverNegative: !inDebtSince });
        if (v.length) throw new Error(`case ${c}: ${v.join('; ')}`);
        if (!inDebtSince) expect(m.state.B).toBeGreaterThanOrEqual(0);
      }
    }
    expect(reversalsChecked).toBeGreaterThan(2500);
    expect(overReversals).toBeGreaterThan(100);
  });

  it('DE-10 property: random negative starts × all permutations of ≤ 4 reversals → order-free B, D, O, Σowed (2,500 cases)', () => {
    const rnd = prng(0xde10);
    let permsRun = 0;
    for (let c = 0; c < 2500; c++) {
      let m = legacyDebtDebit(emptyModel(), randInt(rnd, 1, 3000)).model;
      let nid = 0;
      const steps = randInt(rnd, 2, 15);
      for (let i = 0; i < steps; i++) {
        const roll = rnd();
        const posIds = Object.values(m.positions).filter(
          (p) => p.reversed < p.amount,
        );
        const liveLots = m.lots.filter((l) => l.remaining > 0);
        if (roll < 0.45) {
          m = credit(m, {
            id: `c${nid++}`,
            amount: randInt(rnd, 1, 1500),
            reversible: rnd() < 0.85,
          }).model;
        } else if (roll < 0.6 && m.state.B > 0) {
          m = spend(m, randInt(rnd, 1, m.state.B)).model;
        } else if (roll < 0.7 && liveLots.length) {
          m = expire(
            m,
            liveLots[randInt(rnd, 0, liveLots.length - 1)].id,
          ).model;
        } else if (roll < 0.78) {
          m = legacyDebtDebit(m, randInt(rnd, 1, 800)).model;
        } else if (posIds.length) {
          const p = posIds[randInt(rnd, 0, posIds.length - 1)];
          m = reverse(m, p.id, randInt(rnd, 1, p.amount - p.reversed)).model;
        }
      }
      // ensure at least one reversible credit with cap left
      if (!Object.values(m.positions).some((p) => p.reversed < p.amount)) {
        m = credit(m, {
          id: `c${nid++}`,
          amount: randInt(rnd, 1, 1500),
          reversible: true,
        }).model;
      }
      // pick k ≤ 4 back-to-back reversals, Σ per credit ≤ a − ρ
      const left: Record<string, number> = {};
      for (const p of Object.values(m.positions))
        left[p.id] = p.amount - p.reversed;
      const k = randInt(rnd, 1, 4);
      const revs: [string, number][] = [];
      for (let j = 0; j < k; j++) {
        const ids = Object.keys(left).filter((id) => left[id] > 0);
        if (!ids.length) break;
        const id = ids[randInt(rnd, 0, ids.length - 1)];
        const r = randInt(rnd, 1, left[id]);
        left[id] -= r;
        revs.push([id, r]);
      }
      let ref: {
        B: number;
        D: number;
        O: Record<string, [number, number]>;
        sf: number;
        H: number;
      } | null = null;
      for (const perm of permutations(revs)) {
        let w = m;
        let sf = 0;
        for (const [id, r] of perm) {
          const floor = reversalFloor(w, id);
          const s = reverse(w, id, r);
          // below the no-new-debt floor only by the owed part (owner 2026-11-19)
          expect(s.model.state.B).toBeGreaterThanOrEqual(floor - s.movement.owed);
          expect(s.model.state.B).toBe(w.state.B - (r - s.movement.alreadyExpired));
          expect(s.movement.shortfall).toBe(0);
          sf += s.movement.owed;
          w = s.model;
          const v = checkInvariants(w);
          if (v.length) throw new Error(`case ${c}: ${v.join('; ')}`);
        }
        const got = {
          B: w.state.B,
          D: w.state.D,
          O: offsets(w),
          sf,
          H: holdings(w.state),
        };
        if (!ref) ref = got;
        else expect(got).toEqual(ref);
        permsRun++;
      }
    }
    expect(permsRun).toBeGreaterThan(2500);
  });
});

// ───────────────────────────── backfill replay ─────────────────────────────

/** Converts live v2 movements into the historical form the backfill sees (recorded deltas only). */
function toHistory(
  events: ModelEvent[],
  movements: Movement[],
  lotsBefore: Record<string, number>[],
): HistoricalEvent[] {
  return movements.map((mv, i) => {
    const ev = events[i];
    const id = `wt${i}`;
    switch (mv.kind) {
      case 'CREDIT':
        return {
          type: 'credit',
          id: mv.refId!,
          delta: mv.pointsDelta,
          reversible: (ev as { reversible?: boolean }).reversible ?? true,
        };
      case 'SPEND':
      case 'LEGACY_DEBT_DEBIT':
        return { type: 'debit', id, delta: mv.pointsDelta };
      case 'EXPIRY':
        return {
          type: 'expiry',
          id,
          delta: mv.pointsDelta,
          lotRemaining: lotsBefore[i][mv.refId!],
          ownerCreditId: mv.offsetPositionId,
        };
      case 'REVERSAL':
        return {
          type: 'clawback',
          id,
          creditId: mv.refId!,
          delta: mv.pointsDelta,
          requested: mv.pointsRequested,
        };
    }
  });
}

describe('replay (§3 backfill)', () => {
  it('reproduces D, O_X, ρ_X of random live histories exactly; p = min(|δ|, O_X) (2,000 cases)', () => {
    const rnd = prng(0xbac0);
    for (let c = 0; c < 2000; c++) {
      const events: ModelEvent[] = [];
      const lotsBefore: Record<string, number>[] = [];
      const movements: Movement[] = [];
      let m = emptyModel();
      if (rnd() < 0.6) {
        const ev: ModelEvent = {
          type: 'legacyDebit',
          amount: randInt(rnd, 1, 2000),
        };
        lotsBefore.push(lotMap(m));
        const s = legacyDebtDebit(m, ev.amount);
        events.push(ev);
        movements.push(s.movement);
        m = s.model;
      }
      let nid = 0;
      const steps = randInt(rnd, 3, 25);
      for (let i = 0; i < steps; i++) {
        const roll = rnd();
        const posIds = Object.values(m.positions).filter(
          (p) => p.reversed < p.amount,
        );
        const liveLots = m.lots.filter((l) => l.remaining > 0);
        let ev: ModelEvent | null = null;
        if (roll < 0.4)
          ev = cr(`c${nid++}`, randInt(rnd, 1, 1500), rnd() < 0.85);
        else if (roll < 0.55 && m.state.B > 0)
          ev = sp(randInt(rnd, 1, m.state.B));
        else if (roll < 0.65 && liveLots.length)
          ev = {
            type: 'expire',
            lotId: liveLots[randInt(rnd, 0, liveLots.length - 1)].id,
          };
        else if (roll < 0.72)
          ev = { type: 'legacyDebit', amount: randInt(rnd, 1, 800) };
        else if (posIds.length) {
          const p = posIds[randInt(rnd, 0, posIds.length - 1)];
          ev = rev(p.id, randInt(rnd, 1, p.amount - p.reversed));
        }
        if (!ev) continue;
        lotsBefore.push(lotMap(m));
        const step = run([ev], m);
        events.push(ev);
        movements.push(step.movements[0]);
        m = step.model;
      }
      const res = replay(toHistory(events, movements, lotsBefore), m.state.B);
      // a live over-reversal (owner 2026-11-19) is exactly what the replay books as CLAWBACK_BEYOND_HOLDINGS ("owed",
      // as debt) — the only anomaly a live history can produce, and the replayed D / O still match the live state
      expect(res.anomalies.map((a) => a.code)).toEqual(
        movements.filter((mv) => mv.kind === 'REVERSAL' && mv.owed > 0).map(() => 'CLAWBACK_BEYOND_HOLDINGS'),
      );
      expect(res.state).toEqual(m.state);
      for (const p of Object.values(m.positions)) {
        expect([
          res.positions[p.id].offset,
          res.positions[p.id].reversed,
        ]).toEqual([p.offset, p.reversed]);
      }
      movements.forEach((mv, i) => {
        if (mv.kind === 'REVERSAL') {
          expect(res.classifications[i].debtRestored).toBe(mv.debtRestored);
          expect(res.classifications[i].recovered).toBe(mv.recovered);
        }
      });
    }
  });

  it('Bajaj negative wallet: vendor-import debit, credits, historical clawback classified p = min(|δ|, O_X)', () => {
    const hist: HistoricalEvent[] = [
      { type: 'debit', id: 'imp', delta: -841 },
      { type: 'credit', id: 'X', delta: 500, reversible: true },
      { type: 'credit', id: 'Y', delta: 600, reversible: true },
      { type: 'clawback', id: 'cb1', creditId: 'Y', delta: -400 },
    ];
    const res = replay(hist, -141);
    // after X: D 341, O_X 500; after Y: O_Y 341, D 0, B 259; clawback 400 of Y: p 341, c 59
    expect(res.anomalies).toEqual([]);
    expect(res.state).toEqual({ B: -141, D: 341, seq: 4 });
    expect(res.positions.X).toMatchObject({ offset: 500, reversed: 0 });
    expect(res.positions.Y).toMatchObject({ offset: 0, reversed: 400 });
    expect(res.classifications[3]).toMatchObject({
      debtRestored: 341,
      recovered: 59,
      pointsDelta: -400,
    });
  });

  it('T-h2: historical clawback past holdings / of an unresolvable credit → kept as recorded, classified, flagged', () => {
    const res = replay(
      [
        { type: 'credit', id: 'X', delta: 300, reversible: true },
        { type: 'debit', id: 'r', delta: -300 },
        { type: 'clawback', id: 'cb', creditId: 'X', delta: -300 }, // legacy floor let it go to −300
        { type: 'clawback', id: 'cb2', creditId: 'GONE', delta: -50 },
      ],
      -350,
    );
    expect(res.state).toEqual({ B: -350, D: 350, seq: 4 }); // B as recorded, H = 0 ≥ 0
    expect(res.anomalies.map((a) => a.code)).toEqual([
      'CLAWBACK_BEYOND_HOLDINGS',
      'CLAWBACK_UNKNOWN_CREDIT',
    ]);
    expect(res.positions.X).toMatchObject({ offset: 0, reversed: 300 });
  });

  it('flags a final balance mismatch and over-cap clawbacks', () => {
    const res = replay(
      [
        { type: 'credit', id: 'X', delta: 100, reversible: true },
        {
          type: 'clawback',
          id: 'cb',
          creditId: 'X',
          delta: -100,
          requested: 150,
        },
      ],
      7,
    );
    expect(res.anomalies.map((a) => a.code)).toEqual([
      'CLAWBACK_OVER_CAP',
      'FINAL_BALANCE_MISMATCH',
    ]);
  });
});
