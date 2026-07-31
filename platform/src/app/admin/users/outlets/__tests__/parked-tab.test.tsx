/// <reference types="vitest/globals" />
/**
 * Parked / Removed tab — Park confirm POSTs the collected outlet codes.
 *
 * Mirrors the Deactivate tab: upload a single-column Outlet-ID xlsx → client-side
 * validate against the loaded tenant outlet list → Confirm → POST
 * /api/admin/outlets/park with { outletCodes }.
 *
 * `xlsx` is mocked so the FileReader → XLSX.read → sheet_to_json parse path yields a
 * deterministic set of rows without a real spreadsheet binary.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Deterministic parse output for every upload in this file.
const { rowsHolder } = vi.hoisted(() => ({ rowsHolder: { rows: [] as Record<string, string>[] } }));
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('xlsx')>();
  return {
    ...actual,
    read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
    utils: { ...actual.utils, sheet_to_json: vi.fn(() => rowsHolder.rows) },
  };
});

import OutletsPage from '../page';

/** Two KYC-pending outlets so park validation OKs both uploaded codes. */
const IDS_OUTLETS = [
  { outletId: 'OUT-P1', outletName: 'Park Shop 1', isActive: false, kycStatus: 'NOT_STARTED' },
  { outletId: 'OUT-P2', outletName: 'Park Shop 2', isActive: false, kycStatus: 'NOT_STARTED' },
];

let parkBody: unknown = null;

function stubFetch() {
  parkBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const json = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
      if (url === '/api/admin/outlets/ids') {
        return json({ success: true, data: { outlets: IDS_OUTLETS } });
      }
      if (url.startsWith('/api/admin/outlets?')) {
        return json({ success: true, data: { outlets: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 }, outletTypes: ['SSS'] } });
      }
      if (url === '/api/admin/hierarchy-config') {
        return json({ success: true, data: { employees: [] } });
      }
      if (url === '/api/admin/outlets/park') {
        parkBody = init?.body ? JSON.parse(init.body as string) : null;
        return json({ success: true, data: { parked: 2, notFound: [] } });
      }
      // useGifsySettings → api.get('/api/settings'): no-op (refresh leaves cache as-is).
      if (url === '/api/settings') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }),
  );
}

function makeXlsx(name = 'park.xlsx'): File {
  return new File([new Uint8Array([80, 75, 3, 4])], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('Parked / Removed tab — Park confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowsHolder.rows = [{ 'Outlet ID': 'OUT-P1' }, { 'Outlet ID': 'OUT-P2' }];
    stubFetch();
  });

  it('POSTs the collected outlet codes to /api/admin/outlets/park', async () => {
    render(<OutletsPage />);

    // Wait until the full tenant list has loaded (drives park validation).
    await waitFor(() => expect(screen.getByTestId('stat-total-outlets')).toHaveTextContent('2'));

    // Switch to the Parked / Removed tab.
    fireEvent.click(screen.getByRole('tab', { name: /Parked \/ Removed/i }));

    // Upload the (mock-parsed) outlet-code file to the Park block.
    fireEvent.change(screen.getByTestId('park-upload-input'), { target: { files: [makeXlsx()] } });

    // Validation panel appears with a Confirm button.
    const panel = await screen.findByTestId('park-validation-panel');
    const confirm = within(panel).getByTestId('confirm-outlet-upload-btn');
    fireEvent.click(confirm);

    // The Park confirm POSTed the two collected codes.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/admin/outlets/park', expect.objectContaining({ method: 'POST' })),
    );
    expect(parkBody).toEqual({ outletCodes: ['OUT-P1', 'OUT-P2'] });

    // Success summary shows the backend parked count.
    expect(await screen.findByText(/2 outlet\(s\) parked/i)).toBeInTheDocument();
  });
});
