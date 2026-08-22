/// <reference types="vitest/globals" />
/**
 * Publish + pricing dialog — shows the ₹→points derivation from each tenant's conversion
 * rate, lets the operator override it, and POSTs the resolved publications.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/publish-pricing.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
  },
  authHeader: () => ({}),
}));

import { PublishDialog } from '../publish-dialog';
import type { GiftMasterSummary, TenantPublishRow } from '@/lib/gift-catalogue';

const MASTER: GiftMasterSummary = {
  id: 'gm1', code: 'GM-1', name: 'JBL Speaker', categoryId: 'c1', mrpPaise: 300000,
  redemptionMode: 'PHYSICAL_GIFT', fulfilmentChannel: 'GIFSY_WAREHOUSE', status: 'ACTIVE',
  stockQuantity: null, imageUrls: [],
};

// One tenant already published: ₹1000 @ 2 points/₹ → derived 2000 (== stored → not overridden).
const ROWS: TenantPublishRow[] = [
  { clientId: 'cl1', clientName: 'Deoleo', conversionRate: 2, published: true, sellingValuePaise: 100000, pointsCost: 2000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ success: true, data: { items: ROWS } });
  post.mockResolvedValue({ success: true, data: {} });
});

describe('PublishDialog', () => {
  it('derives points from ₹ × conversion rate and updates as the price changes', async () => {
    render(<PublishDialog master={MASTER} onClose={() => {}} onPublished={() => {}} />);

    // Initial derived = round(1000 × 2) = 2000
    await waitFor(() => expect(screen.getByTestId('publish-derived-cl1').textContent).toBe('2,000'));

    // Change price to ₹1500 → derived 3000
    fireEvent.change(screen.getByTestId('publish-price-cl1'), { target: { value: '1500' } });
    await waitFor(() => expect(screen.getByTestId('publish-derived-cl1').textContent).toBe('3,000'));
  });

  it('honours a manual points override in the effective cost + the POST body', async () => {
    const onPublished = vi.fn();
    render(<PublishDialog master={MASTER} onClose={() => {}} onPublished={onPublished} />);

    await screen.findByTestId('publish-price-cl1');
    fireEvent.change(screen.getByTestId('publish-price-cl1'), { target: { value: '1500' } });
    fireEvent.change(screen.getByTestId('publish-override-cl1'), { target: { value: '2500' } });

    // Effective line reflects the override, not the derived 3000.
    await waitFor(() =>
      expect(screen.getByTestId('publish-effective-cl1').textContent).toMatch(/2,500 points/),
    );

    // Publish → confirm → POST with the overridden points + ₹ price in paise.
    fireEvent.click(screen.getByTestId('publish-open-confirm'));
    fireEvent.click(await screen.findByTestId('publish-confirm'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0] as [string, { publications: { clientId: string; sellingValuePaise: number; pointsCost: number }[] }];
    expect(url).toBe('/api/admin/gift-masters/gm1/publish');
    expect(body.publications).toEqual([
      { clientId: 'cl1', sellingValuePaise: 150000, pointsCost: 2500 },
    ]);
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
  });

  it('blocks publish when a selected tenant has an invalid price', async () => {
    render(<PublishDialog master={MASTER} onClose={() => {}} onPublished={() => {}} />);
    await screen.findByTestId('publish-price-cl1');
    fireEvent.change(screen.getByTestId('publish-price-cl1'), { target: { value: '' } });
    await screen.findByTestId('publish-error-cl1');
    expect(screen.getByTestId('publish-open-confirm')).toBeDisabled();
  });
});
