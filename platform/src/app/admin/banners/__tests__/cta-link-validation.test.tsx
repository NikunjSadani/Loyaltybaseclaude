/** Admin banners (audit fix 2026-11-21): a non-http(s) button link is refused inline; a refused save is shown. */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/platform/use-outlet-type-labels', () => ({ useOutletTypeLabels: () => ({ overrides: new Map(), loading: false }) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import BannersPage from '../page';

const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const EXISTING = {
  id: 'b1', active: true, type: 'text', title: 'Diwali', body: '', ctaLabel: 'Go', ctaUrl: 'javascript:alert(1)', videoUrl: '',
  bgColor: 'red', audience: 'ALL', priority: 0, startDate: '', endDate: '', showInSalesApp: false, updatedAt: '',
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((_u: unknown, init?: RequestInit) =>
    init?.method === 'PUT'
      ? json(400, { success: false, error: { message: 'Button links must start with http:// or https:// (or be left blank).' } })
      : json(200, { success: true, data: { banners: [EXISTING], popups: [] } }));
});

describe('admin banners — CTA link', () => {
  it('a javascript: link stored earlier is not rendered as a link in the list', async () => {
    render(<BannersPage />);
    await screen.findAllByText('Diwali');
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('typing a non-http(s) link shows the inline error and disables Save', async () => {
    render(<BannersPage />);
    await screen.findAllByText('Diwali');
    fireEvent.click(screen.getByRole('button', { name: /New Banner/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. 🎉 Diwali Special!'), { target: { value: 'Offer' } });
    const link = screen.getAllByPlaceholderText('https://...')[0];
    fireEvent.change(link, { target: { value: 'javascript:alert(1)' } });
    expect(screen.getByRole('alert').textContent).toBe('Must start with http:// or https:// (or leave blank).');
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    fireEvent.change(link, { target: { value: 'https://bajaj.example/offer' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled();
  });

  it('a save the server refuses shows "Not saved: <reason>"', async () => {
    render(<BannersPage />);
    await screen.findAllByText('Diwali');
    fireEvent.click(screen.getByTitle('Deactivate')); // toggling re-PUTs the whole config → the server refuses it
    await waitFor(() => expect(screen.getByTestId('banner-save-error').textContent).toBe(
      'Not saved: Button links must start with http:// or https:// (or be left blank).',
    ));
  });
});
