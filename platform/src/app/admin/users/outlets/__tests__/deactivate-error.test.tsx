/// <reference types="vitest/globals" />
/**
 * Deactivate error surfacing (#57 — all-invalid false "success")
 *
 * Previously the deactivate confirm did `fetch(...).catch(()=>{})` and then
 * unconditionally set the success panel — so an API 400 (e.g. all rows invalid)
 * was swallowed and the user saw a false success. This verifies the page now
 * surfaces the API error and does NOT show the success panel on a non-OK response.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

/* Mock xlsx so parseXlsx returns a single deactivatable row. */
vi.mock('xlsx', () => ({
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
  utils: {
    sheet_to_json: vi.fn(() => [{ 'Outlet ID': 'OUT-2026-001' }]),
    book_new: vi.fn(() => ({})),
    aoa_to_sheet: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
  writeFile: vi.fn(),
}));

const ACTIVE_OUTLET = {
  outletId: 'OUT-2026-001', outletName: 'Test Outlet', outletType: 'KIRANA',
  programName: 'P', programCategory: 'C', beat: 'B1', distributorId: 'D1',
  city: 'Mumbai', state: 'MH', metro: false, xsrId: 'X1', xsrName: 'XSR One',
  kycStatus: 'APPROVED', isActive: true, addedDate: '2026-01-01',
};

import OutletsPage from '../page';

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'test-token'), setItem: vi.fn() });
  // FileReader: invoke onload synchronously with an ArrayBuffer.
  class FakeFileReader {
    onload: ((e: { target: { result: ArrayBuffer } }) => void) | null = null;
    onerror: (() => void) | null = null;
    readAsArrayBuffer() { this.onload?.({ target: { result: new ArrayBuffer(8) } }); }
  }
  vi.stubGlobal('FileReader', FakeFileReader as unknown as typeof FileReader);
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function stubFetch(deactivateResponse: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/admin/outlets') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [ACTIVE_OUTLET] } }) });
    }
    if (url === '/api/admin/hierarchy-config') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { employees: [] } }) });
    }
    if (url === '/api/admin/outlets/deactivate') {
      return Promise.resolve(deactivateResponse);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function uploadAndReachConfirm() {
  render(<OutletsPage />);
  // Wait for the active outlet to load (so the row validates as OK).
  await screen.findByText('Test Outlet');
  fireEvent.click(screen.getByRole('tab', { name: /deactivate/i }));
  const input = screen.getByTestId('deactivate-upload-input') as HTMLInputElement;
  const file = new File(['x'], 'deactivate.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
  // The confirm button only renders when validation marks the row OK.
  return screen.findByTestId('confirm-outlet-upload-btn');
}

describe('Deactivate — error surfacing', () => {
  it('surfaces the API error and does NOT show success when deactivate returns 400', async () => {
    stubFetch({ ok: false, status: 400, json: () => Promise.resolve({ error: 'All outlet IDs are invalid' }) } as Partial<Response>);
    const confirmBtn = await uploadAndReachConfirm();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toHaveTextContent(/all outlet ids are invalid/i);
    });
    // The false-success panel must NOT appear.
    expect(screen.queryByText(/upload processed successfully/i)).not.toBeInTheDocument();
  });

  it('shows the success panel when deactivate returns OK', async () => {
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) } as Partial<Response>);
    const confirmBtn = await uploadAndReachConfirm();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/upload processed successfully/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('submit-error')).not.toBeInTheDocument();
  });
});
