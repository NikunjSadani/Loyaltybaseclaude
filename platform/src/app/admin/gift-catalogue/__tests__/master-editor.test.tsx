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
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
