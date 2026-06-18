/* ─── Demo wallet sample data ────────────────────────────────────────────────
   Used ONLY as a fallback when the backend returns no data AND the partner
   portal is running under a demo session (the `partner_outlet_type_demo`
   localStorage key set by `@/lib/partner-session`).

   Production authenticated wallets that receive real data from
   /api/wallet, /api/wallet/transactions and /api/partner/payouts are
   UNAFFECTED — real fetched data always takes precedence over these samples.
─────────────────────────────────────────────────────────────────────────────── */

import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';
import type { PayoutLedgerEntry } from '@/types';

const SESSION_KEY = 'partner_outlet_type_demo';

/** True when the partner portal is running under a demo session. */
export function isDemoSession(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SESSION_KEY) != null;
}

/* ── POINTS track (WHOLESALER) ── */

export const DEMO_WALLET_BALANCE: WalletBalance = {
  earned:     8_550,
  locked:     0,
  redeemable: 4_250,
  redeemed:   4_300,
  expired:    0,
  available:  4_250,
};

export const DEMO_POINTS_TRANSACTIONS: WalletTransaction[] = [
  {
    id:             'demo-tx-1',
    walletId:       'demo-w1',
    userId:         'demo-u1',
    type:           TransactionType.CREDIT,
    bucket:         WalletBucket.EARNED,
    amount:         1_500,
    balanceAfter:   8_550,
    description:    'Monthly Sales Target — May 2026',
    schemeId:       'demo-scheme-1',
    invoiceId:      null,
    kpiLabel:       'Monthly Sales Target',
    narration:      'Achieved 112% of target — bonus tier credited.',
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date('2026-05-14T00:00:00.000Z'),
  },
  {
    id:             'demo-tx-2',
    walletId:       'demo-w1',
    userId:         'demo-u1',
    type:           TransactionType.CREDIT,
    bucket:         WalletBucket.EARNED,
    amount:         800,
    balanceAfter:   7_050,
    description:    'New SKU Activation — May 2026',
    schemeId:       'demo-scheme-2',
    invoiceId:      null,
    kpiLabel:       'New SKU Activation',
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date('2026-05-10T00:00:00.000Z'),
  },
  {
    id:             'demo-tx-3',
    walletId:       'demo-w1',
    userId:         'demo-u1',
    type:           TransactionType.DEBIT,
    bucket:         WalletBucket.REDEEMED,
    amount:         2_000,
    balanceAfter:   6_250,
    description:    'Redemption – Amazon Voucher',
    schemeId:       null,
    invoiceId:      null,
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date('2026-05-08T00:00:00.000Z'),
  },
];

/* ── INR track (RETAILER 'SSS') ── */

export const DEMO_INR_PAYOUTS: PayoutLedgerEntry[] = [
  {
    id:              'demo-payout-1',
    period:          '2026-05',
    kpiLabel:        'Visibility',
    achievedPct:     100,
    payoutAmountInr: 4_500,
    uploadedAt:      '2026-05-02T00:00:00.000Z',
    utr:             'UTR2605VIS001',
    paidAt:          '2026-05-12T00:00:00.000Z',
    status:          'PAID',
    narration:       'Shelf-display audit passed — full visibility payout.',
  },
  {
    id:              'demo-payout-2',
    period:          '2026-05',
    kpiLabel:        'Monthly Sales Target',
    achievedPct:     108,
    payoutAmountInr: 8_000,
    uploadedAt:      '2026-05-02T00:00:00.000Z',
    utr:             'UTR2605MST001',
    paidAt:          '2026-05-12T00:00:00.000Z',
    status:          'PAID',
  },
];
