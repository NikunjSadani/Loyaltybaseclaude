/// <reference types="vitest/globals" />
/**
 * Gift-master editor — validation blocks a bad save, a valid save POSTs the right payload.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/master-editor.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
    put: (url: string, body: unknown) => put(url, body),
    del: (url: string) => post(url),
  },
  authHeader: () => ({}),
}));

import { MasterEditor } from '../page';
import type { GiftCategory } from '@/lib/gift-catalogue';

const CATEGORIES: GiftCategory[] = [
  { id: 'c1', parentId: null, code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0, isActive: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ success: true, data: { id: 'gm-new' } });
  put.mockResolvedValue({ success: true, data: {} });
});

describe('MasterEditor (create)', () => {
  it('blocks save + shows validation errors when required fields are blank', async () => {
    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />);

    fireEvent.click(screen.getByTestId('save-master-btn'));

    await screen.findByTestId('master-errors');
    expect(screen.getByTestId('master-errors').textContent).toMatch(/Name is required/);
    expect(post).not.toHaveBeenCalled();
  });

  it('POSTs the correct payload (rupees→paise) for a valid master', async () => {
    const onSaved = vi.fn();
    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'JBL Speaker' } });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'GM-JBL' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('field-mrp'), { target: { value: '2499' } });

    fireEvent.click(screen.getByTestId('save-master-btn'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/admin/gift-masters');
    expect(body).toMatchObject({
      name: 'JBL Speaker', code: 'GM-JBL', categoryId: 'c1', mrpPaise: 249900,
      amountType: 'FIXED', minAmountPaise: null, maxAmountPaise: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('MasterEditor — FIXED vs FLEXIBLE (free-amount)', () => {
  it('hides the amount-type toggle for a physical (FIXED-only) mode; shows it for gift card', () => {
    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />);
    // Default mode is PHYSICAL_GIFT → no toggle.
    expect(screen.queryByTestId('amount-type-section')).toBeNull();
    // Switch to GIFT_CARD → the toggle appears.
    fireEvent.change(screen.getByTestId('field-redemption-mode'), { target: { value: 'GIFT_CARD' } });
    expect(screen.getByTestId('amount-type-section')).toBeTruthy();
  });

  it('blocks save when flexible is chosen but the max ₹ is blank', async () => {
    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Amazon' } });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'GM-AMZ' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('field-redemption-mode'), { target: { value: 'GIFT_CARD' } });
    fireEvent.click(screen.getByTestId('amount-type-flex'));
    fireEvent.change(screen.getByTestId('field-min-amount'), { target: { value: '100' } });
    // max left blank
    fireEvent.click(screen.getByTestId('save-master-btn'));

    await screen.findByTestId('master-errors');
    expect(screen.getByTestId('master-errors').textContent).toMatch(/Maximum amount/);
    expect(post).not.toHaveBeenCalled();
  });

  it('POSTs a FREE_AMOUNT master with the ₹ band (rupees→paise)', async () => {
    const onSaved = vi.fn();
    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Amazon' } });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'GM-AMZ' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('field-redemption-mode'), { target: { value: 'GIFT_CARD' } });
    fireEvent.click(screen.getByTestId('amount-type-flex'));
    fireEvent.change(screen.getByTestId('field-min-amount'), { target: { value: '100' } });
    fireEvent.change(screen.getByTestId('field-max-amount'), { target: { value: '5000' } });
    fireEvent.click(screen.getByTestId('save-master-btn'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, body] = post.mock.calls[0];
    expect(body).toMatchObject({
      amountType: 'FREE_AMOUNT', minAmountPaise: 10000, maxAmountPaise: 500000,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('an uploaded image URL flows into the imageUrls textarea and the create payload', async () => {
    const IMG = 'https://storage.googleapis.com/gifsy-platform-files/gift-catalogue/2026-09/uuid-a.png';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { url: IMG } }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<MasterEditor masterId={null} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'JBL Speaker' } });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'GM-JBL' } });
    fireEvent.change(screen.getByTestId('field-category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('field-mrp'), { target: { value: '2499' } });

    // Upload a picture — the returned URL should land in the (synced) URL textarea.
    fireEvent.change(screen.getByTestId('gift-image-input'), {
      target: { files: [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect((screen.getByTestId('field-images') as HTMLTextAreaElement).value).toContain(IMG));

    fireEvent.click(screen.getByTestId('save-master-btn'));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    expect(body).toMatchObject({ imageUrls: [IMG] });
  });
});
