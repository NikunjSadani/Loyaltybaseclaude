/**
 * Regression: the Outlet Master upload must NOT validate against an unloaded /
 * empty outlet-type list. Before this guard, uploading while the tenant config
 * was still loading (or after a failed fetch) rejected EVERY row with a false
 * "no outlet types are enabled for this tenant" — even though the tenant has
 * types. The upload is now gated until the config is ready, and a genuinely
 * empty list shows a corrected, tenant-workspace-aware message.
 *
 * Run: npx vitest run src/app/admin/users/outlets/__tests__/outlet-upload-config-guard.test.tsx
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

function mockConfig(outletTypes: string[]) {
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/admin/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [], outletTypes } }) });
    }
    if (typeof url === 'string' && url.includes('/api/admin/hierarchy-config')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { employees: [{ id: 'XSR-1', roleCode: 'XSR' }] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
});

describe('Outlet Master upload — tenant-config load guard', () => {
  it('enables the upload once outlet types + hierarchy have loaded', async () => {
    mockConfig(['SSS', 'WHOLESALER']);
    render(<OutletsPage />);
    // Active dropzone appears (config ready) and the disabled placeholder is gone.
    await waitFor(() => expect(screen.getByText(/Drop your XLSX file/i)).toBeInTheDocument());
    expect(screen.queryByTestId('upload-disabled')).not.toBeInTheDocument();
  });

  it('blocks the upload with a tenant-workspace hint when zero outlet types are enabled (no false rejection)', async () => {
    mockConfig([]);
    render(<OutletsPage />);
    await waitFor(() => expect(screen.getByTestId('upload-disabled')).toBeInTheDocument());
    // The corrected message points at tenant context, not "ask Gifsy to enable".
    expect(screen.getByTestId('upload-disabled')).toHaveTextContent(/correct tenant workspace/i);
    // The active dropzone is hidden so a file can't be validated against an empty list.
    expect(screen.queryByText(/Drop your XLSX file/i)).not.toBeInTheDocument();
  });
});
