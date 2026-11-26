/// <reference types="vitest/globals" />
/**
 * Payout statement row — TDS withheld (owner audit A-M3/B-M1, 2026-11-18): a payout fully withheld as
 * TDS reads "Withheld as TDS ₹X — ₹0 paid to you" (no "Paid ₹X", no UTR); a partly withheld one shows
 * the TDS taken under the net amount.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PayoutStatementRow } from '../payout-statement-row';
import type { PayoutLedgerEntry } from '@/types';

const base: PayoutLedgerEntry = {
  id: 'e1', period: '2026-05', kpiLabel: 'Visibility', achievedPct: 100, payoutAmountPaise: 500000,
  uploadedAt: '2026-05-31T00:00:00.000Z', paidAt: '2026-06-02T00:00:00.000Z', status: 'PAID', utr: 'UTR123',
};

describe('PayoutStatementRow — TDS withheld', () => {
  it('fully withheld: "Withheld as TDS ₹5,000 — ₹0 paid to you", amount ₹0, no UTR line', () => {
    render(<PayoutStatementRow entry={{ ...base, payoutAmountPaise: 0, grossAmountPaise: 500000, tdsWithheldPaise: 500000, settledByTds: true, utr: undefined }} />);
    expect(screen.getByTestId('payout-tds-note')).toHaveTextContent('Withheld as TDS ₹5,000 — ₹0 paid to you');
    expect(screen.getByText('₹0')).toBeInTheDocument();
    expect(screen.queryByText(/UTR/)).toBeNull();
  });

  it('partly withheld: net amount + "TDS ₹500 withheld"', () => {
    render(<PayoutStatementRow entry={{ ...base, payoutAmountPaise: 450000, grossAmountPaise: 500000, tdsWithheldPaise: 50000 }} />);
    expect(screen.getByText('₹4,500')).toBeInTheDocument();
    expect(screen.getByTestId('payout-tds-note')).toHaveTextContent('TDS ₹500 withheld from ₹5,000');
  });

  it('no TDS: unchanged (no note)', () => {
    render(<PayoutStatementRow entry={base} />);
    expect(screen.queryByTestId('payout-tds-note')).toBeNull();
    expect(screen.getByText('UTR UTR123')).toBeInTheDocument();
    expect(screen.queryByTestId('payout-offportal-badge')).toBeNull();
    expect(screen.queryByTestId('payout-gift-badge')).toBeNull();
  });
});

describe('PayoutStatementRow — off-portal payments register', () => {
  it('off-portal cash row: "Paid outside the portal" badge, no Gift badge', () => {
    render(<PayoutStatementRow entry={{ ...base, offPortal: true }} />);
    expect(screen.getByTestId('payout-offportal-badge')).toHaveTextContent('Paid outside the portal');
    expect(screen.queryByTestId('payout-gift-badge')).toBeNull();
  });

  it('off-portal gift row: both badges', () => {
    render(<PayoutStatementRow entry={{ ...base, offPortal: true, gift: true }} />);
    expect(screen.getByTestId('payout-offportal-badge')).toBeInTheDocument();
    expect(screen.getByTestId('payout-gift-badge')).toHaveTextContent('Gift (off-portal)');
  });
});
