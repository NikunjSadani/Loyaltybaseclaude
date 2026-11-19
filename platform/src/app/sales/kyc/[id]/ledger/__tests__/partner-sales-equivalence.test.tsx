/// <reference types="vitest/globals" />
/**
 * EQ — equivalence: the partner's own wallet (/partner/wallet) and the sales view of the same
 * outlet (/sales/kyc/[id]/ledger), fed EQUIVALENT data (same balance, statement rows, payouts and
 * activity flags — each through its own endpoint shape), render the SAME cards and the SAME rows
 * (titles, amounts, order) and the same statement controls.
 *
 *   EQ1: wholesaler, points + payouts, "Incl. Activation" flag ON
 *   EQ2: payout-only retailer (SSS), loyalty OFF
 *   EQ3: no activity at all
 *
 * Dates are computed RELATIVE to `new Date()` — never hardcoded.
 */
import React, { Suspense, act } from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
let mockIdentity: Record<string, unknown> = {};
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => mockIdentity }));

import WalletPage from '@/app/partner/wallet/page';
import OutletLedgerPage from '../page';

function at(monthsBack: number, day: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, day, 12).toISOString();
}
function period(monthsBack: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface Scenario {
  flags: { outletType: string; hasPointsActivity: boolean; hasPayoutActivity: boolean; loyaltyEnabled: boolean; inclFlag: boolean };
  balance: Record<string, number>;
  rows: unknown[]; // GET /wallet/statement rows (OLDEST first) — the ledger's `statement.rows` too
  payouts: unknown[];
}

const BAL = (earned: number, redeemable: number) => ({
  earnedPoints: earned, lockedPoints: 0, redeemablePoints: redeemable, redeemedPoints: earned - redeemable,
  expiredPoints: 0, lifetimeEarned: earned, lifetimeRedeemed: earned - redeemable,
});
const row = (id: string, date: string, transactionType: string, points: number, balanceAfter: number,
  extra: Record<string, unknown> = {}) => ({
  id, date, transactionType, points, balanceAfter, balanceBefore: balanceAfter - points,
  description: transactionType === 'DEBIT_REDEMPTION' ? 'Points redeemed' : 'Points earned',
  narration: null, fieldName: null, referenceType: null, referenceId: null, ...extra,
});
const pay = (id: string, monthsBack: number, paise: number, kpiLabel: string, status = 'PAID') => ({
  id, period: period(monthsBack), kpiLabel, achievedPct: 100, payoutAmountPaise: paise,
  uploadedAt: at(monthsBack, 3), paidAt: status === 'PAID' ? at(monthsBack, 9) : null,
  utr: status === 'PAID' ? `UTR-${id}` : null, status, narration: null,
});

const SCENARIOS: Record<string, Scenario> = {
  'EQ1 wholesaler points + payouts, flag ON': {
    flags: { outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: true, loyaltyEnabled: true, inclFlag: true },
    balance: BAL(1500, 1100),
    rows: [
      row('t1', at(3, 5), 'CREDIT_BONUS', 1000, 1000, { fieldName: 'Monthly Target', narration: 'Q push', description: 'Q push', referenceType: 'CREDIT_BATCH' }),
      row('t2', at(2, 6), 'CREDIT_POINTS_EARNED', 500, 1500, { fieldName: 'Visibility', referenceType: 'CREDIT_BATCH' }),
      row('t3', at(1, 7), 'DEBIT_REDEMPTION', -400, 1100),
    ],
    payouts: [pay('p1', 2, 250_000, 'Incentive'), pay('p2', 1, 75_000, 'Activation', 'PENDING')],
  },
  'EQ2 payout-only retailer, loyalty OFF': {
    flags: { outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: true, loyaltyEnabled: false, inclFlag: true },
    balance: BAL(0, 0),
    rows: [],
    payouts: [pay('p1', 3, 120_000, 'Visibility'), pay('p2', 1, 80_000, 'Incentive')],
  },
  'EQ3 no activity': {
    flags: { outletType: 'RETAILER', hasPointsActivity: false, hasPayoutActivity: false, loyaltyEnabled: true, inclFlag: false },
    balance: BAL(0, 0),
    rows: [],
    payouts: [],
  },
};

function stub(s: Scenario) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    if (u.startsWith('/api/wallet/statement')) return ok({ openingBalance: 0, closingBalance: 0, currentBalance: 0, outletCode: 'OUT-1', outletName: 'Shop', rows: s.rows });
    if (u.startsWith('/api/wallet')) return ok({ ...s.balance, currency: 'POINTS', conversionRate: 1 });
    if (u.startsWith('/api/partner/payouts')) return ok({ payouts: s.payouts });
    if (u.startsWith('/api/kyc/')) {
      return ok({
        meta: {
          name: 'Shop', outletCode: 'OUT-1', mobile: '98', balance: 0, lifetime: 0, redeemed: 0,
          outletType: s.flags.outletType, hasPointsActivity: s.flags.hasPointsActivity,
          hasPayoutActivity: s.flags.hasPayoutActivity, loyaltyEnabled: s.flags.loyaltyEnabled,
          wholesalerPayoutInclActivation: s.flags.inclFlag, walletBalance: s.balance,
        },
        statement: { openingBalance: 0, closingBalance: 0, currentBalance: 0, outletCode: 'OUT-1', rows: s.rows },
        payouts: s.payouts,
      });
    }
    return ok({}); // /api/settings
  }));
}

/** The rendered wallet below the page header: cards + statement controls + rows. */
function snapshotView() {
  const controls = screen.getByTestId('statement-controls-row');
  const statement = controls.closest('.overflow-hidden') as HTMLElement;
  const wrapper = statement.parentElement as HTMLElement;
  const cards = Array.from(wrapper.children)
    .filter((el) => el !== statement && el.className.includes('rounded-2xl'))
    .map((el) => el.textContent);
  const list = statement.querySelector('.divide-y');
  const rows = list ? Array.from(list.children).map((el) => el.textContent) : [];
  const chips = Array.from(statement.querySelectorAll('button.rounded-full')).map((b) => b.textContent);
  const kpi = Array.from(screen.getByTestId('wallet-kpi-filter').querySelectorAll('option')).map((o) => o.textContent);
  const empty = statement.textContent?.includes('No transactions for this period') ?? false;
  return { cards, rows, chips, kpi, period: screen.getByTestId('period-picker-btn').textContent, empty };
}

async function renderPartner(s: Scenario) {
  mockIdentity = {
    businessName: 'Shop', ownerName: 'O', partnerCode: 'P1', outletType: s.flags.outletType,
    hasPointsActivity: s.flags.hasPointsActivity, hasPayoutActivity: s.flags.hasPayoutActivity,
    loyaltyEnabled: s.flags.loyaltyEnabled, features: { wholesalerPayoutInclActivation: s.flags.inclFlag },
  };
  stub(s);
  const r = render(<WalletPage />);
  await screen.findByTestId('statement-controls-row', {}, { timeout: 15_000 });
  const snap = snapshotView();
  r.unmount();
  return snap;
}

async function renderSales(s: Scenario) {
  stub(s);
  const params = Promise.resolve({ id: 'k1' });
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(<Suspense fallback={<div>Loading…</div>}><OutletLedgerPage params={params} /></Suspense>);
    await params;
  });
  await screen.findByTestId('statement-controls-row', {}, { timeout: 15_000 });
  const snap = snapshotView();
  r.unmount();
  return snap;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('EQ — partner wallet ≡ sales outlet wallet for equivalent data', () => {
  it.each(Object.entries(SCENARIOS))('%s', async (_name, s) => {
    const partner = await renderPartner(s);
    const sales = await renderSales(s);
    expect(sales).toEqual(partner);

    // Guard against a vacuous pass (both empty): the expected cards / rows really rendered.
    const expectedCards = (s.flags.hasPointsActivity ? 1 : 0) + (s.flags.hasPayoutActivity ? 1 : 0);
    expect(partner.cards).toHaveLength(expectedCards);
    expect(partner.rows).toHaveLength(s.rows.length + s.payouts.length);
    if (s.flags.outletType === 'WHOLESALER' && s.flags.inclFlag) {
      expect(partner.cards.join(' ')).toContain('Incl. Activation');
    }
  });
});
