/// <reference types="vitest/globals" />
/**
 * SW — the sales view of an outlet's wallet renders the SAME shared <OutletWalletView> as the
 * partner's own wallet, driven by the ledger `meta` signals (shared backend
 * resolveOutletWalletActivity — the same as /partner/me). Owner-approved, platform-wide, 2026-11-19.
 *
 *   SW1: payout-only retailer (SSS) → NO points card ("0 pts" gone), the ₹ payout card IS shown
 *   SW2: wholesaler with points + payout, tenant flag ON → both cards + "Incl. Activation"
 *   SW3: same wholesaler, flag OFF → both cards, NO "Incl. Activation"
 *   SW4: flag ON but a non-wholesaler outlet → NO "Incl. Activation"
 *   SW5: an outlet with no activity → no cards; the statement still renders (empty)
 *   SW6: a missing points statement → the statement error (never "No transactions")
 *   SW7: the whole ledger fails to load → the page-level error with a back link
 *   SW8: the points card reads earnedPoints (the partner card's figure), not lifetimeEarned
 *   SW9: loyalty OFF hides the Earn/Burn chips; KPI filter is "All Parameters" and drops
 *        "Visibility" for a non-SSS outlet
 *   SW10: period — opens on the full activity range; picker allows up to the current month;
 *         Reset returns to the FULL range (not the current month)
 *
 * All dates are computed RELATIVE to `new Date()` — never hardcoded.
 */

import React, { Suspense, act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

/* ── Relative-date helpers (mid-month, midday → no IST/UTC month-edge ambiguity) ── */
const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthsAgo(n: number): Date { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() - n, 15, 12); }
function ym(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function label(d: Date): string { return `${MONTH_SHORT[d.getMonth() + 1]} ${d.getFullYear()}`; }

const ZERO_BAL = {
  earnedPoints: 0, lockedPoints: 0, redeemablePoints: 0, redeemedPoints: 0,
  expiredPoints: 0, lifetimeEarned: 0, lifetimeRedeemed: 0,
};

function pointsRow(id: string, at: Date, points: number, balanceAfter: number, fieldName: string | null = 'Monthly Scheme') {
  return {
    id, date: at.toISOString(), transactionType: points >= 0 ? 'CREDIT_BONUS' : 'DEBIT_REDEMPTION',
    description: points >= 0 ? 'note' : 'Points redeemed', narration: points >= 0 ? 'note' : null,
    fieldName: points >= 0 ? fieldName : null, points, balanceBefore: balanceAfter - points, balanceAfter,
    referenceType: null, referenceId: null,
  };
}
function payout(id: string, at: Date, paise: number, kpiLabel = 'Incentive') {
  return { id, period: ym(at), kpiLabel, achievedPct: 100, payoutAmountPaise: paise,
    uploadedAt: at.toISOString(), paidAt: at.toISOString(), utr: `UTR-${id}`, status: 'PAID' };
}

function stubLedger(data: Record<string, unknown> | null, opts: { reject?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.startsWith('/api/kyc/')) {
      if (opts.reject) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    }
    // /api/settings (useGifsySettings background refresh) — no override.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

function ledger(meta: Record<string, unknown>, rows: unknown[] | undefined, payouts: unknown[] = []) {
  return {
    meta: { name: 'Verma Traders', outletCode: 'OUT-1', mobile: '98', balance: 0, lifetime: 0, redeemed: 0,
      walletBalance: ZERO_BAL, loyaltyEnabled: true, wholesalerPayoutInclActivation: false, ...meta },
    ...(rows === undefined ? {} : { statement: { rows } }),
    payouts,
  };
}

async function renderLedger() {
  const params = Promise.resolve({ id: 'k1' });
  await act(async () => {
    render(<Suspense fallback={<div>Loading…</div>}><OutletLedgerPage params={params} /></Suspense>);
    await params;
  });
}
async function renderLoaded() {
  await renderLedger();
  expect(await screen.findByTestId('statement-controls-row', {}, { timeout: 15_000 })).toBeInTheDocument();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SW — sales outlet wallet renders the shared partner wallet view', () => {
  it('SW1: a payout-only retailer gets the payout card and NO points card', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: true, loyaltyEnabled: false },
      [], [payout('p1', m, 350_000)],
    ));
    await renderLoaded();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
    expect(screen.getByText('Lifetime Payout')).toBeInTheDocument();
    // Lifetime Payout = ₹3,500 (the card's headline figure).
    expect(screen.getByTestId('payout-summary').querySelector('p.text-3xl')?.textContent).toBe('₹3,500');
    // The old always-on points card is gone ("Lifetime Earned … 0 pts").
    expect(screen.queryByText('Lifetime Earned')).not.toBeInTheDocument();
    expect(screen.queryByText('Available to Redeem')).not.toBeInTheDocument();
  });

  it('SW2: a wholesaler with points + payout and the tenant flag ON → both cards + "Incl. Activation"', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: true, wholesalerPayoutInclActivation: true,
        walletBalance: { ...ZERO_BAL, earnedPoints: 500, redeemablePoints: 500, lifetimeEarned: 500 } },
      [pointsRow('t1', m, 500, 500)], [payout('p1', m, 100_000)],
    ));
    await renderLoaded();
    expect(screen.getByText('Lifetime Earned')).toBeInTheDocument();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
    expect(screen.getByTestId('payout-incl-activation')).toHaveTextContent('Incl. Activation');
  });

  it('SW3: the same wholesaler with the flag OFF → both cards, no "Incl. Activation"', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: true, wholesalerPayoutInclActivation: false,
        walletBalance: { ...ZERO_BAL, earnedPoints: 500, redeemablePoints: 500, lifetimeEarned: 500 } },
      [pointsRow('t1', m, 500, 500)], [payout('p1', m, 100_000)],
    ));
    await renderLoaded();
    expect(screen.getByText('Lifetime Earned')).toBeInTheDocument();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('payout-incl-activation')).not.toBeInTheDocument();
  });

  it('SW4: flag ON but a non-wholesaler outlet → no "Incl. Activation"', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: true, wholesalerPayoutInclActivation: true },
      [], [payout('p1', m, 100_000)],
    ));
    await renderLoaded();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('payout-incl-activation')).not.toBeInTheDocument();
  });

  it('SW5: an outlet with no activity → no cards; the statement renders empty', async () => {
    stubLedger(ledger({ outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: false }, [], []));
    await renderLoaded();
    expect(screen.queryByTestId('payout-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Lifetime Earned')).not.toBeInTheDocument();
    expect(screen.getByText('No transactions for this period')).toBeInTheDocument();
    expect(screen.getByTestId('period-picker-btn').textContent).toContain(label(new Date()));
  });

  it('SW6: a missing points statement shows the statement error, never an empty statement', async () => {
    stubLedger(ledger({ outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: false }, undefined, []));
    await renderLoaded();
    expect(screen.getByTestId('statement-load-error')).toHaveTextContent("Couldn't load this outlet's statement");
    expect(screen.queryByText('No transactions for this period')).not.toBeInTheDocument();
  });

  it('SW7: the ledger request failing shows the page-level error with a back link', async () => {
    stubLedger(null, { reject: true });
    await renderLedger();
    expect(await screen.findByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('← Back').getAttribute('href')).toBe('/sales/kyc');
    expect(screen.queryByTestId('statement-controls-row')).not.toBeInTheDocument();
  });

  it('SW8: the points card reads earnedPoints (as the partner card does), not lifetimeEarned', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
        // meta.lifetime (the old card figure) deliberately differs from earnedPoints.
        lifetime: 9999,
        walletBalance: { ...ZERO_BAL, earnedPoints: 1234, redeemablePoints: 600, lifetimeEarned: 9999 } },
      [pointsRow('t1', m, 1234, 1234)],
    ));
    await renderLoaded();
    const card = screen.getByText('Lifetime Earned').closest('div')!.parentElement!;
    expect(card.textContent).toContain('1,234');
    expect(card.textContent).toContain('600 pts');
    expect(card.textContent).not.toContain('9,999');
  });

  it('SW9: loyalty OFF hides Earn/Burn; KPI filter is "All Parameters" and drops Visibility for a non-SSS outlet', async () => {
    const m = monthsAgo(1);
    stubLedger(ledger(
      { outletType: 'WHOLESALER', hasPointsActivity: false, hasPayoutActivity: true, loyaltyEnabled: false },
      [], [payout('p1', m, 100_000, 'Visibility'), payout('p2', m, 50_000, 'Incentive')],
    ));
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'Earn' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Burn' })).not.toBeInTheDocument();
    const options = Array.from(screen.getByTestId('wallet-kpi-filter').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['All Parameters', 'Incentive']);
  });

  it('SW10: opens on the full activity range; picker reaches the current month; Reset returns to the full range', async () => {
    const older = monthsAgo(3);
    const recent = monthsAgo(2);
    stubLedger(ledger(
      { outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true,
        walletBalance: { ...ZERO_BAL, earnedPoints: 100, redeemablePoints: 100, lifetimeEarned: 100 } },
      [pointsRow('t1', older, 100, 100)], [payout('p1', recent, 100_000)],
    ));
    await renderLoaded();
    const full = `${label(older)} – ${label(recent)}`;
    expect(screen.getByTestId('period-picker-btn').textContent).toContain(full);

    fireEvent.click(screen.getByTestId('period-picker-btn'));
    await waitFor(() => expect(document.querySelectorAll('input[type="month"]').length).toBe(2));
    const [fromInput, toInput] = Array.from(document.querySelectorAll('input[type="month"]')) as HTMLInputElement[];
    // The To picker is NOT capped at the last activity month — it reaches today.
    expect(toInput.max >= ym(new Date())).toBe(true);

    // Narrow to the older month only, then Reset → back to the FULL range (not the current month).
    fireEvent.change(fromInput, { target: { value: ym(older) } });
    fireEvent.change(toInput, { target: { value: ym(older) } });
    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(screen.getByTestId('period-picker-btn').textContent).toContain(label(older)));
    expect(screen.getByTestId('period-picker-btn').textContent).not.toContain('–');

    fireEvent.click(screen.getByTestId('period-picker-btn'));
    fireEvent.click(screen.getByText('Reset'));
    await waitFor(() => expect(screen.getByTestId('period-picker-btn').textContent).toContain(full));
  });
});
