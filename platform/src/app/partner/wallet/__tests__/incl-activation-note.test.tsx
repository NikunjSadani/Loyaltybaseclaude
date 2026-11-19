/// <reference types="vitest/globals" />
/**
 * IA — "Incl. Activation" sub-line on the wallet Lifetime Payout card (owner 2026-11-19).
 *
 * Tenant flag `wholesalerPayoutInclActivation` (Bajaj ON, Deoleo OFF). The note shows ONLY when the
 * flag is ON AND the partner's outlet type is WHOLESALER. Flag OFF (Deoleo) or a retailer → the card is
 * unchanged (no note).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const identityRef: { current: Record<string, unknown> } = { current: {} };
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => identityRef.current,
}));

import WalletPage from '../page';
import { statementPayload } from './statement-fixture';

const PAID_PAYOUT = {
  id: 'ce-paid', status: 'PAID', period: '2026-05', kpiLabel: 'Monthly Scheme',
  payoutAmountPaise: 80_000, uploadedAt: '2026-05-05T00:00:00.000Z',
  paidAt: '2026-05-20T00:00:00.000Z', utr: 'UTR-PAID',
};

function setIdentity(outletType: string, flag: boolean | undefined) {
  identityRef.current = {
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType, hasPointsActivity: false, hasPayoutActivity: true,
    features: flag === undefined ? undefined : { wholesalerPayoutInclActivation: flag },
  };
}

async function renderCard() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/wallet/statement'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statementPayload([])) });
    if (url.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [PAID_PAYOUT] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
  render(<WalletPage />);
  return screen.findByTestId('payout-summary', {}, { timeout: 15_000 });
}

describe('IA — "Incl. Activation" note on the Lifetime Payout card', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('IA1: wholesaler + flag ON → "Incl. Activation" shows under "Lifetime Payout", in a smaller font', async () => {
    setIdentity('WHOLESALER', true);
    const card = await renderCard();
    const note = await screen.findByTestId('payout-incl-activation');
    expect(note.textContent).toBe('Incl. Activation');
    expect(note.className).toContain('text-[10px]'); // smaller than the text-xs label
    expect(card.textContent).toContain('Lifetime Payout');
  });

  it('IA2: wholesaler + flag OFF (Deoleo) → no note', async () => {
    setIdentity('WHOLESALER', false);
    const card = await renderCard();
    expect(card.textContent).toContain('Lifetime Payout');
    expect(screen.queryByTestId('payout-incl-activation')).toBeNull();
  });

  it('IA3: retailer + flag ON → no note (wholesalers only)', async () => {
    setIdentity('RETAILER', true);
    await renderCard();
    expect(screen.queryByTestId('payout-incl-activation')).toBeNull();
  });

  it('IA4: features not loaded yet → no note', async () => {
    setIdentity('WHOLESALER', undefined);
    await renderCard();
    expect(screen.queryByTestId('payout-incl-activation')).toBeNull();
  });
});
