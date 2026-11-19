/**
 * Plain-words outcome of a POINTS credit reversal (display only — never changes what is written).
 *
 * Owner decision 2026-11-19: on the V2 engine a reversal larger than what the wallet holds is NOT written off — the
 * remainder becomes wallet debt, repaid from future earnings. The LEGACY engine (Deoleo) keeps its own rule: the wallet
 * floors at 0 and what it no longer holds is written off (settled off-platform). The summary says which happened:
 *
 *   V2:     "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings"
 *   LEGACY: "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 not recovered — already spent, written off (settle off-platform)"
 *
 * The same text is built for the approve response (from what the engine just did) and for the reversal list (from the
 * stored allocation rows, or — for a reversal with none — approvedPaise / shortfallPaise), so the screen never
 * re-derives it. Reversals approved before 2026-11-19 keep their recorded outcome (a written-off shortfall stays one).
 */

/** What a POINTS reversal did, in whole points. */
export interface PointsReversalSplit {
  /** approved r */
  reversed: number;
  /** c — taken from the points the wallet held */
  recovered: number;
  /** p — debt the reversed credit had paid off, owed again */
  debtRestored: number;
  /** s — V2 (owner 2026-11-19): the part the wallet no longer held, booked as debt */
  owed: number;
  /** written off (LEGACY floor 0 / approvals before 2026-11-19): settled off-platform */
  shortfall: number;
}

export interface PointsOutcome extends PointsReversalSplit {
  /** e.g. "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings" */
  headline: string;
  /** the same without the decision prefix — one line per reversal in the reversal report */
  summary: string;
  /** one sentence per part (for a detail list) */
  lines: string[];
}

const pts = (n: number) => new Intl.NumberFormat('en-IN').format(n);

function parts(s: PointsReversalSplit): string[] {
  const out: string[] = [];
  if (s.recovered > 0) out.push(`${pts(s.recovered)} taken from the wallet`);
  if (s.debtRestored > 0) out.push(`${pts(s.debtRestored)} of earlier debt this credit had paid off is owed again`);
  if (s.owed > 0) out.push(`${pts(s.owed)} recorded as debt, repaid from future earnings`);
  if (s.shortfall > 0) out.push(`${pts(s.shortfall)} not recovered — already spent, written off (settle off-platform)`);
  return out;
}

/** Summary of an approved POINTS reversal. `requested` (when larger than `reversed`) marks a partial approval. */
export function pointsOutcome(s: PointsReversalSplit, opts: { requested?: number } = {}): PointsOutcome {
  const partial = opts.requested !== undefined && opts.requested > s.reversed;
  const prefix = partial ? `Partially approved (${pts(opts.requested!)} pts requested)` : 'Approved';
  if (s.reversed <= 0) {
    const summary = '0 pts reversed — the wallet is unchanged';
    return { ...s, headline: `${prefix} · ${summary}`, summary, lines: [summary] };
  }
  const p = parts(s);
  const summary = [`${pts(s.reversed)} pts reversed`, ...p].join(' · ');
  return {
    ...s,
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
    shortfall: 0,
    headline: `Rejected · ${summary}`,
    summary,
    lines: ['Nothing was reversed — the wallet is unchanged'],
  };
}

/**
 * The split of a stored, approved POINTS reversal (reversal list): from its allocation rows when they cover the whole
 * approved amount (V2, or LEGACY on a sequenced wallet, or classified by the backfill), else from the reversal's own
 * approvedPaise / shortfallPaise (LEGACY floor 0: taken = approved − shortfall).
 */
export function storedPointsSplit(
  r: { approvedPaise: bigint | number | null; shortfallPaise: bigint | number | null },
  allocations: Array<{ requested: number; debtRestored: number; recovered: number; owed: number; shortfall: number }>,
): PointsReversalSplit {
  const reversed = Number(r.approvedPaise ?? 0);
  const covered = allocations.reduce((n, a) => n + a.requested, 0);
  if (allocations.length > 0 && covered === reversed) {
    return {
      reversed,
      recovered: allocations.reduce((n, a) => n + a.recovered, 0),
      debtRestored: allocations.reduce((n, a) => n + a.debtRestored, 0),
      owed: allocations.reduce((n, a) => n + a.owed, 0),
      shortfall: allocations.reduce((n, a) => n + a.shortfall, 0),
    };
  }
  const shortfall = Math.min(reversed, Number(r.shortfallPaise ?? 0));
  return { reversed, recovered: reversed - shortfall, debtRestored: 0, owed: 0, shortfall };
}
