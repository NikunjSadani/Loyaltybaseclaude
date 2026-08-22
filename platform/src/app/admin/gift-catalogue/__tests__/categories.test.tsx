/// <reference types="vitest/globals" />
/**
 * Category editor ops — validation + create POST + the self-parent cycle guard.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/categories.test.tsx
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

import { CategoryEditor } from '../categories/page';
import type { GiftCategory } from '@/lib/gift-catalogue';

const TREE: GiftCategory[] = [
  { id: 'a', parentId: null, code: 'A', name: 'A', imageUrl: null, sortOrder: 0, isActive: true },
  { id: 'b', parentId: 'a', code: 'B', name: 'B', imageUrl: null, sortOrder: 0, isActive: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ success: true, data: { id: 'cat-new' } });
  put.mockResolvedValue({ success: true, data: {} });
});

describe('CategoryEditor', () => {
  it('blocks save + shows errors when name/code blank', async () => {
    render(<CategoryEditor editing={null} allCategories={[]} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByTestId('save-category-btn'));
    await screen.findByTestId('category-errors');
    expect(screen.getByTestId('category-errors').textContent).toMatch(/Name is required/);
    expect(post).not.toHaveBeenCalled();
  });

  it('POSTs a valid new category with parentId null for top level', async () => {
    const onSaved = vi.fn();
    render(<CategoryEditor editing={null} allCategories={TREE} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('cat-name'), { target: { value: 'Home & Kitchen' } });
    fireEvent.change(screen.getByTestId('cat-code'), { target: { value: 'HOME' } });
    fireEvent.click(screen.getByTestId('save-category-btn'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/admin/gift-categories');
    expect(body).toMatchObject({ name: 'Home & Kitchen', code: 'HOME', parentId: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('excludes self + descendants from the parent picker (no cycle)', () => {
    // Editing 'a': its only options should NOT include 'a' itself or its child 'b'.
    render(<CategoryEditor editing={TREE[0]} allCategories={TREE} onClose={() => {}} onSaved={() => {}} />);
    const select = screen.getByTestId('cat-parent') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain('a');
    expect(values).not.toContain('b');
    expect(values).toContain(''); // (Top level) always available
  });

  it('PUTs when editing an existing category', async () => {
    render(<CategoryEditor editing={TREE[1]} allCategories={TREE} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByTestId('cat-name'), { target: { value: 'B renamed' } });
    fireEvent.click(screen.getByTestId('save-category-btn'));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe('/api/admin/gift-categories/b');
    expect(post).not.toHaveBeenCalled();
  });
});
