/**
 * Plain-words outcome of a POINTS credit reversal (display only — never changes what is written).
 *
 * It says what the outlet's BALANCE did (fix round 3, A5 — 2026-11-19), in at most four parts that add up to the points
 * reversed:
 *   taken from the wallet   = the part of the balance drop that stayed at or above zero
 *   already expired         = V2: the credit's own points that had already expired — nothing to recover (owner D-1)
 *   owed (debt)             = V2: how far below zero THIS reversal took the balance — "points owed" (owner decision D1),
 *                             repaid from future earnings (owner 2026-11-19: never written off)
 *   not recovered           = LEGACY floor 0 (and approvals before 2026-11-19): written off
 * plus, when relevant, what was behind the owed part (earlier debt the credit had paid off; points that were covering
 * earlier debt). Examples:
 *   V2:     "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings"
 *   LEGACY: "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 not recovered — already redeemed or expired, written off"
 *
 * Built for the approve response (from what the engine just did) and for the reversal list (from the stored allocation
 * rows + the reversal's own wallet rows), so the screen never re-derives it. Reversals approved before 2026-11-19 keep
 * their recorded outcome (a written-off shortfall stays one).
 */

/** What a POINTS reversal did, in whole points. */
export interface PointsReversalSplit {
  /** approved r */
  reversed: number;
  /** c — taken from the points the wallet held (lot draws) */
  recovered: number;
  /** p — debt the reversed credit had paid off, restored */
  debtRestored: number;
  /** s — V2: the part the wallet no longer held, booked as debt */
  owed: number;
  /** q — V2: the credit's own points that had already expired — nothing to recover (absent = 0) */
  alreadyExpired?: number;
  /** V2: part of c that was covering EXISTING debt (the balance went below zero by it — fix round 3, A4) */
  debtExposed?: number;
  /** V2: how far below zero THIS reversal took the balance = the "points owed" it added (owner D1). Absent = 0. */
  belowZero?: number;
  /** written off (LEGACY floor 0 / approvals before 2026-11-19): settled off-platform */
  shortfall: number;
}

export interface PointsOutcome extends PointsReversalSplit {
  /** the part of the balance drop that stayed at or above zero */
  taken: number;
  /** e.g. "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings" */
  headline: string;
  /** the same without the decision prefix — one line per reversal in the reversal report */
  summary: string;
  /** one sentence per part (for a detail list) */
  lines: string[];
}

const pts = (n: number) => new Intl.NumberFormat('en-IN').format(n);

/** taken = r − q − belowZero − written off (never negative). */
export function takenOf(s: PointsReversalSplit): number {
  return Math.max(0, s.reversed - (s.alreadyExpired ?? 0) - (s.belowZero ?? 0) - s.shortfall);
}

function parts(s: PointsReversalSplit): string[] {
  const out: string[] = [];
  const taken = takenOf(s);
  const q = s.alreadyExpired ?? 0;
  const owed = s.belowZero ?? 0;
  if (taken > 0) out.push(`${pts(taken)} taken from the wallet`);
  if (q > 0) out.push(`${pts(q)} already expired — nothing to recover`);
  if (owed > 0) {
    // What was behind the owed part — only what is true: spent points (s), earlier debt restored (p), points that
    // were covering earlier debt (A4). The owner's wording for the plain over-reversal case is kept as it is.
    const why: string[] = [];
    if (s.debtRestored > 0) why.push(`${pts(s.debtRestored)} of earlier debt this credit had paid off is owed again`);
    if ((s.debtExposed ?? 0) > 0) why.push(`${pts(s.debtExposed ?? 0)} of the points taken were covering earlier debt`);
    out.push(
      why.length === 0 && owed === s.owed
        ? `${pts(owed)} recorded as debt, repaid from future earnings`
        : `${pts(owed)} owed (balance below zero), repaid from future earnings${why.length ? ` — ${why.join('; ')}` : ''}`,
    );
  } else if (s.debtRestored > 0) {
    // p while the balance stayed ≥ 0: the balance simply dropped by it (already in "taken") — say what it was.
    out.push(`incl. ${pts(s.debtRestored)} of earlier debt this credit had paid off (restored; the balance stays at or above zero)`);
  }
  // audit item 5: LEGACY's floor-0 write-off covers points redeemed AND points that expired
  if (s.shortfall > 0) out.push(`${pts(s.shortfall)} not recovered — already redeemed or expired, written off`);
  return out;
}

function withDefaults(s: PointsReversalSplit): PointsReversalSplit & { alreadyExpired: number; debtExposed: number; belowZero: number } {
  return { ...s, alreadyExpired: s.alreadyExpired ?? 0, debtExposed: s.debtExposed ?? 0, belowZero: s.belowZero ?? 0 };
}

/** Summary of an approved POINTS reversal. `requested` (when larger than `reversed`) marks a partial approval. */
export function pointsOutcome(s: PointsReversalSplit, opts: { requested?: number } = {}): PointsOutcome {
  const partial = opts.requested !== undefined && opts.requested > s.reversed;
  const prefix = partial ? `Partially approved (${pts(opts.requested!)} pts requested)` : 'Approved';
  const full = withDefaults(s);
  if (s.reversed <= 0) {
    const summary = '0 pts reversed — the wallet is unchanged';
    return { ...full, taken: 0, headline: `${prefix} · ${summary}`, summary, lines: [summary] };
  }
  const p = parts(s);
  const summary = [`${pts(s.reversed)} pts reversed`, ...p].join(' · ');
  return {
    ...full,
    taken: takenOf(s),
    headline: `${prefix} · ${summary}`,
    summary,
    lines: p.map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`),
  };
}

/** A rejected POINTS reversal: nothing moved. */
export function rejectedPointsOutcome(): PointsOutcome {
  const summary = 'nothing was reversed — the wallet is unchanged';
  return {
    reversed: 0,
    recovered: 0,
    debtRestored: 0,
    owed: 0,
    alreadyExpired: 0,
    debtExposed: 0,
    belowZero: 0,
    shortfall: 0,
    taken: 0,
    headline: `Rejected · ${summary}`,
    summary,
    lines: ['Nothing was reversed — the wallet is unchanged'],
  };
}

/** The reversal's own wallet rows (V2): how far below zero they took each wallet — Σ per row telescopes per wallet. */
export function belowZeroOfRows(rows: Array<{ balanceBefore: number; balanceAfter: number }>): number {
  return rows.reduce((n, r) => n + Math.max(0, -r.balanceAfter) - Math.max(0, -r.balanceBefore), 0);
}

/**
 * The split of a stored, approved POINTS reversal (reversal list).
 * A7 (fix round 3): the allocation rows are used ONLY when every row was written by the V2 engine (`engineSource` 'V2')
 * and they cover the approved amount. LEGACY clawbacks on sequenced wallets, WP6-backfilled history and rows from before
 * the column existed keep the reversal's OWN recorded figures (approvedPaise / shortfallPaise: taken = approved −
 * shortfall) — so backfilled history never adds a Debt column or shrinks "Reversed" on a LEGACY report.
 */
export function storedPointsSplit(
  r: { approvedPaise: bigint | number | null; shortfallPaise: bigint | number | null },
  allocations: Array<{
    requested: number; debtRestored: number; recovered: number; owed: number; shortfall: number;
    alreadyExpired?: number; debtExposed?: number; engineSource?: string | null;
  }>,
  rows: Array<{ balanceBefore: number; balanceAfter: number }> = [],
): PointsReversalSplit {
  const reversed = Number(r.approvedPaise ?? 0);
  const covered = allocations.reduce((n, a) => n + a.requested, 0);
  const v2 = allocations.length > 0 && allocations.every((a) => a.engineSource === 'V2');
  if (v2 && covered === reversed) {
    return {
      reversed,
      recovered: allocations.reduce((n, a) => n + a.recovered, 0),
      debtRestored: allocations.reduce((n, a) => n + a.debtRestored, 0),
      owed: allocations.reduce((n, a) => n + a.owed, 0),
      alreadyExpired: allocations.reduce((n, a) => n + (a.alreadyExpired ?? 0), 0),
      debtExposed: allocations.reduce((n, a) => n + (a.debtExposed ?? 0), 0),
      belowZero: belowZeroOfRows(rows),
      shortfall: allocations.reduce((n, a) => n + a.shortfall, 0),
    };
  }
  const shortfall = Math.min(reversed, Number(r.shortfallPaise ?? 0));
  return { reversed, recovered: reversed - shortfall, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, belowZero: 0, shortfall };
}

/**
 * An approved UNDO of an upload deduction (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md §6): the deducted points were given
 * back to the wallet that was charged. Nothing is taken, owed or written off. `kind` lets the screens word it apart
 * from a credit reversal.
 */
export function deductionUndoOutcome(
  givenBack: number,
  opts: { requested?: number } = {},
): PointsOutcome & { kind: 'DEDUCTION_UNDO' } {
  const partial = opts.requested !== undefined && opts.requested > givenBack;
  const prefix = partial ? `Partially approved (${pts(opts.requested!)} pts requested)` : 'Approved';
  const summary =
    givenBack > 0 ? `${pts(givenBack)} pts given back to the wallet — deduction undone` : '0 pts given back — the wallet is unchanged';
  return {
    kind: 'DEDUCTION_UNDO',
    reversed: givenBack,
    recovered: 0,
    debtRestored: 0,
    owed: 0,
    alreadyExpired: 0,
    debtExposed: 0,
    belowZero: 0,
    shortfall: 0,
    taken: 0,
    headline: `${prefix} · ${summary}`,
    summary,
    lines: [summary.charAt(0).toUpperCase() + summary.slice(1)],
  };
}
