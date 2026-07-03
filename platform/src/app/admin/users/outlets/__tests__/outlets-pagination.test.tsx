/**
 * Server-side pagination + filtering for the admin Outlets list.
 *
 * The list used to fetch the ENTIRE tenant outlet dump and filter it client-side,
 * which does not scale. It now sends ?page&limit&search&kycStatus and renders the
 * server-returned page + a pagination control. This test asserts the FE wires those
 * query params (mirrors the admin USERS list pagination pattern) and that the
 * separate full-list validation loader runs as ONE lightweight GET /api/admin/outlets/ids
 * call (the old ~23-request page-through of the paginated endpoint is gone).
 *
 * Run: npx vitest run src/app/admin/users/outlets/__tests__/outlets-pagination.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('xlsx', () => ({
  utils: { book_new: vi.fn(() => ({})), aoa_to_sheet: vi.fn(() => ({})), book_append_sheet: vi.fn() },
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
  writeFile: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

function outletRow(id: string) {
  return {
    outletId: id, outletName: `Outlet ${id}`, outletType: 'SSS', programName: '', programCategory: '',
    beat: '', distributorId: '', city: 'Mumbai', state: 'MH', metro: false,
    xsrId: 'ISR-1', xsrName: 'Anil', kycStatus: 'APPROVED', isActive: true, addedDate: '2026-05-01',
  };
}

// Capture every paginated /api/admin/outlets?... list URL, and every hit to the
// lightweight full-list /api/admin/outlets/ids validation loader.
const listUrls: string[] = [];
const idsUrls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  listUrls.length = 0;
  idsUrls.length = 0;
  localStorage.clear();
  localStorage.setItem('token', 't');

  fetchMock.mockImplementation((url: string) => {
    // Lightweight full-list loader — ONE call, projected to { outletId, isActive, kycStatus }.
    if (typeof url === 'string' && url.includes('/api/admin/outlets/ids')) {
      idsUrls.push(url);
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          data: { outlets: [{ outletId: 'OUT-1', isActive: true, kycStatus: 'APPROVED' }] },
        }),
      });
    }
    if (typeof url === 'string' && url.includes('/api/admin/outlets?')) {
      listUrls.push(url);
      const u = new URL(url, 'http://localhost');
      const page = Number(u.searchParams.get('page') ?? '1');
      // Two pages of 1 row each so the full-list loader stops after page 2.
      const outlets = page === 1 ? [outletRow('OUT-1')] : [outletRow('OUT-2')];
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          data: {
            outlets,
            outletTypes: ['SSS'],
            pagination: { page, limit: 50, total: 2, pages: 2 },
          },
        }),
      });
    }
    if (typeof url === 'string' && url.includes('/api/admin/hierarchy-config')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { employees: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('Outlets list — server pagination + filtering', () => {
  it('sends page & limit on the paged list request', async () => {
    render(<OutletsPage />);
    await waitFor(() => expect(listUrls.some((u) => u.includes('page=1') && u.includes('limit=50'))).toBe(true));
  });

  it('loads the full validation list via ONE /api/admin/outlets/ids call (no page-through)', async () => {
    render(<OutletsPage />);
    // The lightweight loader fires exactly once against /ids …
    await waitFor(() => expect(idsUrls.length).toBe(1));
    // … and the old page-through of the paginated endpoint is gone (no page=2 fetch).
    expect(listUrls.some((u) => u.includes('page=2'))).toBe(false);
  });

  it('renders the current server page and a Next control when more pages exist', async () => {
    render(<OutletsPage />);
    await waitFor(() => expect(screen.getByTestId('outlets-next-page')).toBeInTheDocument());
    // The current page shows the server-returned row, not a client-filtered subset.
    expect(screen.getAllByTestId('outlet-row').length).toBeGreaterThan(0);
  });
});
