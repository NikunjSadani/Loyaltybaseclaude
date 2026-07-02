/**
 * Regression: "Download Outlet Master" (server export) must actually save the file.
 *
 * The handler fetches /api/admin/reports/outlet-master then triggers a blob download.
 * It previously used a DETACHED <a> (never added to the DOM) whose object URL was
 * revoked SYNCHRONOUSLY right after .click() — and it ran after two awaits (fetch →
 * blob), i.e. outside the click's user-gesture stack. Browsers cancelled that save,
 * so the button silently did nothing (backend returned 200 the whole time). The fix
 * appends the anchor to the DOM and defers the revoke. It also surfaces failures
 * instead of swallowing them.
 *
 * Run: npx vitest run src/app/admin/users/outlets/__tests__/download-outlet-master.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('xlsx', () => ({
  utils: { book_new: vi.fn(() => ({})), aoa_to_sheet: vi.fn(() => ({})), book_append_sheet: vi.fn() },
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
  writeFile: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

function baseFetch(extra?: (url: string) => unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (extra) { const r = extra(url); if (r) return r as Promise<unknown>; }
    if (typeof url === 'string' && url.includes('/api/admin/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [], outletTypes: ['SSS'] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/admin/hierarchy-config')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { employees: [{ id: 'XSR-1', roleCode: 'XSR' }] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
  createObjectURL = vi.fn(() => 'blob:mock');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
});

afterEach(() => { vi.useRealTimers(); });

describe('Download Outlet Master — reliable blob save', () => {
  it('clicks a real (DOM-attached) anchor with the outlet-master filename and defers the revoke', async () => {
    baseFetch((url) =>
      url.includes('/api/admin/reports/outlet-master')
        ? Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['xlsx-bytes'])) })
        : undefined,
    );

    let clickedDownload: string | null = null;
    let connectedAtClick = false;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownload = this.download;
      connectedAtClick = this.isConnected; // must be attached to the DOM (the old detached-anchor bug)
    });

    render(<OutletsPage />);
    await waitFor(() => expect(screen.getByTestId('download-outlet-master')).toBeEnabled());

    fireEvent.click(screen.getByTestId('download-outlet-master'));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(clickedDownload).toMatch(/^outlet-master-.*\.xlsx$/);
    expect(connectedAtClick).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // The revoke must NOT be synchronous with the click (the old bug cancelled the save)…
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // …but the deferred cleanup does fire shortly after.
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1), { timeout: 2000 });

    clickSpy.mockRestore();
  });

  it('surfaces a visible error (not a silent no-op) when the export request fails', async () => {
    baseFetch((url) =>
      url.includes('/api/admin/reports/outlet-master')
        ? Promise.resolve({ ok: false, status: 500, blob: () => Promise.resolve(new Blob()) })
        : undefined,
    );
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<OutletsPage />);
    await waitFor(() => expect(screen.getByTestId('download-outlet-master')).toBeEnabled());
    fireEvent.click(screen.getByTestId('download-outlet-master'));

    await waitFor(() => expect(screen.getByTestId('download-outlet-master-error')).toBeInTheDocument());
    expect(clickSpy).not.toHaveBeenCalled(); // no download attempted on failure

    clickSpy.mockRestore();
  });
});
