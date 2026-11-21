/** Test-only fixtures for the held-opening-balances specs (`.test-spec.ts`: out of the build and of the jest glob). */

/** A Bajaj-style passbook: two earns, a redemption, a lapse → closing 600. */
export const SAMPLE_EVENTS = [
  { d: '2025-04-01', t: 'EARN', p: 500, l: 'Points earned' },
  { d: '2025-06-30', t: 'EARN', p: 400, l: 'Points earned — SPL4 Scratch Payout' },
  { d: '2025-06-30', t: 'REDEEM', p: -200, l: 'Points redeemed' },
  { d: '2026-06-30', t: 'EXPIRE', p: -100, l: 'Points expired' },
];
