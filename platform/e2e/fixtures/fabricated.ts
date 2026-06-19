/**
 * The fabricated-data fail-list (gap #40). These are hardcoded demo-era values that must NEVER
 * appear on a page served against a real DB. The harness fails CI if any surfaces — the
 * enforcement no human can shortcut (GO-LIVE-READINESS.md §2).
 *
 * Keep each token SPECIFIC enough that a legitimate real value can't collide with it. Prefer a
 * contextual phrase ("of 248 partners") over a bare number ("248"). When a new demo leftover is
 * found, add it here, never to a single spec.
 */
export interface FabricatedToken {
  /** the literal substring that must not appear in rendered text */
  text: string;
  /** where it was seen / why it's fabricated — shown in the failure message */
  note: string;
  /**
   * Optional path scoping (S3): only fail this token on pages whose pathname starts with one of
   * these. Use when a token could legitimately appear as real data on some other page. Omit to
   * check it everywhere (the default — most demo leftovers should never appear anywhere).
   */
  onlyOnPaths?: string[];
}

export const FABRICATED_TOKENS: FabricatedToken[] = [
  { text: '8,550', note: 'partner/wallet demo statement balance (real redeemable = 50,000)' },
  { text: '2,947', note: 'partner/dashboard demo "available points" (contradicts real 50,000)' },
  { text: 'of 248 partners', note: 'partner/dashboard demo leaderboard size' },
  { text: '#12 of', note: 'partner/dashboard demo rank' },
  { text: '4,821', note: 'admin Overview demo active-partner count' },
  // CONFIRMED LIVE (2026-06-19, partner slice): the partner portal shell (header + sidebar) renders
  // this hardcoded demo identity on EVERY partner page instead of the real JWT user. The numeric
  // tokens above were NOT seen on partner/dashboard|wallet (already gone or on untested surfaces) —
  // these persona strings are the live #40 offender.
  { text: 'Rajesh Kumar', note: 'partner-shell demo persona name (real user = the logged-in partner)' },
  { text: 'Kumar General Store', note: 'partner-shell demo outlet name' },
  { text: 'Gold Partner', note: 'partner-shell demo tier (retired partner-class concept, #45)' },
];
