/* ─── Partner outlet-type vocabulary ─────────────────────────────────────────
   Outlet-type codes + their display labels/colors, shared by the partner app.

   NOTE: the demo REWARD_TRACK / DEMO_SESSIONS / usePartnerSession machinery that
   previously lived here was RETIRED — the partner app's points-vs-payout experience
   is now driven by REAL data (usePartnerIdentity: hasPointsActivity/hasPayoutActivity,
   outletType) sourced from GET /api/partner/me. Only the outlet-type vocabulary below
   remains, still consumed for labels/colors.
─────────────────────────────────────────────────────────────────────────────── */

export type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT';

export const OUTLET_TYPE_LABELS: Record<OutletType, string> = {
  SSS:          'SSS',
  WHOLESALER:   'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
  SSS_TOT:      'SSS TOT',
};

export const OUTLET_TYPE_COLORS: Record<OutletType, { bg: string; text: string }> = {
  WHOLESALER:   { bg: 'bg-amber-100',   text: 'text-amber-700'  },
  SSS:          { bg: 'bg-blue-100',    text: 'text-blue-700'   },
  SUB_STOCKIST: { bg: 'bg-purple-100',  text: 'text-purple-700' },
  SSS_TOT:      { bg: 'bg-emerald-100', text: 'text-emerald-700'},
};
