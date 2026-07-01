/**
 * schemes-page.test.tsx
 *
 * Component tests for the admin Schemes list page.
 *
 * Verifies:
 *  1. Fetches GET /api/schemes on mount and renders the returned scheme cards.
 *  2. Shows a loading state while the request is in-flight.
 *  3. Shows an error message when the API returns a failure.
 *  4. Calls DELETE /api/schemes/:id when the delete button is clicked (after confirm).
 *  5. Removes the deleted scheme card from the list on success.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ─── Minimal mocks needed for the page ───────────────────────────────────────

// next/link renders <a> in tests
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));

// ─── Fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'test-token'),
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScheme(id: string, name: string) {
  return {
    id,
    code: `CODE_${id}`,
    name,
    description: 'Test description',
    schemeType: 'SALES_INCENTIVE',
    rewardType: 'POINTS',
    startDate: '2026-07-01T00:00:00.000Z',
    endDate:   '2026-09-30T00:00:00.000Z',
    status: 'ACTIVE',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

function mockListSuccess(
  schemes: ReturnType<typeof makeScheme>[],
  pagination?: { page: number; limit: number; total: number; pages: number },
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        schemes,
        pagination: pagination ?? { page: 1, limit: 20, total: schemes.length, pages: 1 },
      },
    }),
  } as Response);
}

// ─── Lazy import (avoids running module-level code at import time) ─────────────

async function renderPage() {
  const { default: SchemesPage } = await import('./page');
  return render(<SchemesPage />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Admin Schemes page', () => {
  it('shows loading spinner while fetching', async () => {
    // Never-resolving promise keeps the loading state visible
    mockFetch.mockReturnValue(new Promise(() => {}));
    await act(async () => { await renderPage(); });
    expect(screen.getByText(/loading schemes/i)).toBeInTheDocument();
  });

  it('renders scheme cards after successful fetch', async () => {
    mockListSuccess([makeScheme('sch-1', 'Summer Push'), makeScheme('sch-2', 'Monsoon Drive')]);

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText('Summer Push')).toBeInTheDocument();
      expect(screen.getByText('Monsoon Drive')).toBeInTheDocument();
    });
  });

  it('shows error message when API returns failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, error: 'Unauthorised' }),
    } as Response);

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText(/unauthorised/i)).toBeInTheDocument();
    });
  });

  it('shows "no schemes" empty state when list is empty', async () => {
    mockListSuccess([]);

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText(/no schemes match your filters/i)).toBeInTheDocument();
    });
  });

  it('calls DELETE /api/schemes/:id and removes card on confirm', async () => {
    // First call: list
    mockListSuccess([makeScheme('sch-del', 'Scheme To Delete')]);
    // Second call: delete
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { message: 'Scheme deleted successfully' } }),
    } as Response);

    // Stub window.confirm to auto-accept
    vi.stubGlobal('confirm', vi.fn(() => true));

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText('Scheme To Delete')).toBeInTheDocument();
    });

    // Click the delete (Archive icon) button
    const deleteBtn = screen.getByTitle('Delete Scheme');
    await act(async () => { fireEvent.click(deleteBtn); });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/schemes/sch-del',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('Scheme To Delete')).not.toBeInTheDocument();
    });
  });

  it('sends ?page&limit on the list request (server pagination)', async () => {
    mockListSuccess([makeScheme('sch-1', 'Summer Push')]);

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText('Summer Push')).toBeInTheDocument();
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/schemes\?/);
    expect(url).toMatch(/page=1/);
    expect(url).toMatch(/limit=20/);
  });

  it('renders Prev/Next for multi-page results and Next advances the page (server refetch)', async () => {
    // Page 1 of 2, then page 2 on Next click.
    mockListSuccess([makeScheme('sch-1', 'Summer Push')], { page: 1, limit: 20, total: 40, pages: 2 });
    mockListSuccess([makeScheme('sch-2', 'Monsoon Drive')], { page: 2, limit: 20, total: 40, pages: 2 });

    await act(async () => { await renderPage(); });

    await waitFor(() => { expect(screen.getByText('Summer Push')).toBeInTheDocument(); });

    const nextBtn = screen.getByText('Next');
    expect(nextBtn).toBeInTheDocument();
    await act(async () => { fireEvent.click(nextBtn); });

    await waitFor(() => { expect(screen.getByText('Monsoon Drive')).toBeInTheDocument(); });
    // The second request carried page=2.
    const url2 = mockFetch.mock.calls[1][0] as string;
    expect(url2).toMatch(/page=2/);
  });

  it('does NOT call DELETE when the user cancels the confirm dialog', async () => {
    mockListSuccess([makeScheme('sch-keep', 'Keep This Scheme')]);
    vi.stubGlobal('confirm', vi.fn(() => false));

    await act(async () => { await renderPage(); });

    await waitFor(() => {
      expect(screen.getByText('Keep This Scheme')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTitle('Delete Scheme');
    await act(async () => { fireEvent.click(deleteBtn); });

    // fetch should only have been called once (the list call)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Card still visible
    expect(screen.getByText('Keep This Scheme')).toBeInTheDocument();
  });
});
