/// <reference types="vitest/globals" />
/**
 * B-L6 — the "Last Month Payout" card keeps its original rule (the single latest PAID payout, by period)
 * and shows its NET amount (gross − TDS withheld). Only when that payout was fully withheld does it say
 * "₹0 — withheld as TDS" (never an older month's figure, never the gross).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: false, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';
import { statementPayload } from './statement-fixture';

const APRIL_PAID = {
  id: 'ce-apr', status: 'PAID', period: '2026-04', kpiLabel: 'Visibility',
  payoutAmountPaise: 80_000, uploadedAt: '2026-04-05T00:00:00.000Z', paidAt: '2026-04-20T00:00:00.000Z', utr: 'UTR-APR',
};
const MAY_WITHHELD = {
  id: 'ce-may', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility',
  payoutAmountPaise: 0, grossAmountPaise: 50_000, tdsWithheldPaise: 50_000, settledByTds: true,
  uploadedAt: '2026-05-05T00:00:00.000Z', paidAt: '2026-05-20T00:00:00.000Z',
};
const MAY_PART_A = {
  id: 'ce-may-a', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility',
  payoutAmountPaise: 27_000, grossAmountPaise: 30_000, tdsWithheldPaise: 3_000,
  uploadedAt: '2026-05-05T00:00:00.000Z', paidAt: '2026-05-20T00:00:00.000Z', utr: 'UTR-A',
};
const MAY_PART_B = {
  id: 'ce-may-b', status: 'PAID', period: '2026-05', kpiLabel: 'Incentive',
  payoutAmountPaise: 20_000, uploadedAt: '2026-05-05T00:00:00.000Z', paidAt: '2026-05-21T00:00:00.000Z', utr: 'UTR-B',
};

function stubFetch(payouts: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/wallet/statement'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statementPayload([])) });
    if (url.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function lastMonthText(payouts: unknown[]): Promise<string> {
  stubFetch(payouts);
  render(<WalletPage />);
  return (await screen.findByTestId('payout-last-month', {}, { timeout: 15_000 })).textContent ?? '';
}

describe('B-L6 — Last Month Payout card', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('the latest month was fully withheld as TDS → "₹0 — withheld as TDS" (not April\'s ₹800, not the ₹500 gross)', async () => {
    const t = await lastMonthText([APRIL_PAID, MAY_WITHHELD]);
    expect(t).toMatch(/May 2026/);
    expect(t).toContain('₹0 — withheld as TDS');
    expect(t).not.toContain('₹800');
    expect(t).not.toContain('₹500');
  });

  it('a partly withheld latest payout shows its NET amount (gross − TDS), no label', async () => {
    const t = await lastMonthText([APRIL_PAID, MAY_PART_A]);
    expect(t).toMatch(/May 2026/);
    expect(t).toContain('₹270'); // ₹300 gross − ₹30 TDS
    expect(t).not.toContain('₹300');
    expect(t).not.toContain('withheld as TDS');
  });

  it('original rule kept: the card shows ONE payout (the latest), never a sum of the month', async () => {
    const t = await lastMonthText([APRIL_PAID, MAY_PART_A, MAY_PART_B]);
    expect(t).toMatch(/May 2026/);
    expect(t).not.toContain('₹470'); // not ₹270 + ₹200
    expect(t).toMatch(/₹270|₹200/);
  });
});
