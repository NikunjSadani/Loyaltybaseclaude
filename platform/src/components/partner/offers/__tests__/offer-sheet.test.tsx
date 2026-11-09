/// <reference types="vitest/globals" />
/**
 * OfferSheet: keeps the LAST tile's content while closing (no flicker to empty / "Offer"),
 * iOS safe-area bottom padding, and "Unlocked" exactly when the API says so.
 * The shared Modal is stubbed to stay mounted so the closing frame is observable in jsdom.
 * Run: npx vitest run src/components/partner/offers/__tests__/offer-sheet.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OfferTilePartner } from '@/lib/offers';

vi.mock('@/components/ui/modal', () => ({
  Modal: ({ open, title, className, children }: { open: boolean; title: string; className?: string; children: React.ReactNode }) => (
    <div data-testid="modal" data-open={String(open)} className={className}>
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Bajaj Consumer Care' } }),
}));

import { OfferSheet, SHEET_CLASS } from '../offer-sheet';

const T: OfferTilePartner = {
  id: 't1', group: 'TARGET_REWARD', valueType: 'RUPEES', valueNumber: 1500.5, valueText: null,
  unitLabel: 'per case', product: 'ADHO 50 ml', label: 'Earn on every case', details: null,
  validTo: '2026-11-30',
  progress: { kpiCode: 'K', kpiName: 'ADHO', unit: 'cases', target: 200, achieved: 199, pct: 100, unlocked: false },
};

describe('OfferSheet', () => {
  it('keeps the last tile rendered while closing (tile → null)', () => {
    const { rerender } = render(<OfferSheet tile={T} onClose={() => {}} />);
    expect(screen.getByText('₹1,500.50')).toBeInTheDocument();
    rerender(<OfferSheet tile={null} onClose={() => {}} />);
    expect(screen.getByTestId('modal')).toHaveAttribute('data-open', 'false');
    expect(screen.getByText('Earn on every case')).toBeInTheDocument();
    expect(screen.queryByText('Offer')).not.toBeInTheDocument();
    expect(screen.getByTestId('offer-sheet')).toBeInTheDocument();
  });

  it('switches to a newly opened tile', () => {
    const { rerender } = render(<OfferSheet tile={T} onClose={() => {}} />);
    rerender(<OfferSheet tile={null} onClose={() => {}} />);
    rerender(<OfferSheet tile={{ ...T, id: 't2', label: 'Second' }} onClose={() => {}} />);
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('"Unlocked" only when the API says unlocked (pct 100 but locked ⇒ none)', () => {
    const { rerender } = render(<OfferSheet tile={T} onClose={() => {}} />);
    expect(screen.queryByTestId('offer-sheet-unlocked')).not.toBeInTheDocument();
    rerender(<OfferSheet tile={{ ...T, id: 't3', progress: { ...T.progress!, unlocked: true } }} onClose={() => {}} />);
    expect(screen.getByTestId('offer-sheet-unlocked')).toHaveTextContent('Unlocked');
  });

  it('bottom padding includes the iOS safe-area inset', () => {
    expect(SHEET_CLASS).toContain('env(safe-area-inset-bottom)');
    render(<OfferSheet tile={T} onClose={() => {}} />);
    expect(screen.getByTestId('modal').className).toContain('safe-area-inset-bottom');
  });
});
