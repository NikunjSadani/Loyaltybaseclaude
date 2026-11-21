/// <reference types="vitest/globals" />
/**
 * Admin App Adoption page — REAL data wiring.
 *
 * Wired to GET /api/push/adoption. These tests prove:
 *  - AD1: subscribed user + device counts render from the fetched payload
 *  - AD2: a role breakdown row and an OS breakdown row render
 *  - AD3: installed user count + a platform breakdown row render
 *  - AD4: empty state ("No installs or subscriptions yet") when all zeros
 *  - AD5: on fetch failure an explicit error state shows (no fabricated numbers)
 *  - AD6–AD9: "Download installed users (Excel)" — button + note, filters in the URL, loading
 *    state while the request is in flight, file saved on 200, readable error on 4xx / network failure
 *  - AD10–AD12: panel disabled with a reason when nobody installed; a 404 "0 users matched these filters"
 *    shows as a neutral note (no file, no error); visible labels are the accessible names
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AppAdoptionPage from '../page';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

const PAYLOAD = {
  clientId: 'deoleo',
  subscribed: {
    users: 128,
    devices: 173,
    byRole: [
      { role: 'PARTNER', users: 90 },
      { role: 'SALES', users: 38 },
    ],
    byOs: [
      { os: 'Android', users: 80 },
      { os: 'iOS', users: 48 },
    ],
  },
  installed: {
    users: 64,
    devices: 71,
    byRole: [
      { role: 'SALES_SO', users: 50 },
      { role: 'WHOLESALER', users: 14 },
    ],
    byPlatform: [
      { platform: 'ANDROID', users: 40 },
      { platform: 'IOS', users: 24 },
    ],
  },
};

const ZERO_PAYLOAD = {
  clientId: 'deoleo',
  subscribed: { users: 0, devices: 0, byRole: [], byOs: [] },
  installed: { users: 0, byPlatform: [] },
};

function mockFetchOk(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Admin App Adoption page — real data', () => {
  it('AD1: renders subscribed user + device counts from the payload', async () => {
    mockFetchOk(PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByText('128')).toBeInTheDocument();
    expect(await screen.findByText('across 173 devices')).toBeInTheDocument();
  });

  it('AD2: renders a role breakdown row and an OS breakdown row', async () => {
    mockFetchOk(PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByText('PARTNER')).toBeInTheDocument();
    // 'Android' now appears in BOTH cards (notifications By OS + installed By OS).
    expect((await screen.findAllByText('Android')).length).toBeGreaterThanOrEqual(1);
  });

  it('AD3: installed card mirrors the notifications card — devices, by role, by OS (friendly OS names)', async () => {
    mockFetchOk(PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByText('64')).toBeInTheDocument();
    expect(await screen.findByText('across 71 devices')).toBeInTheDocument();
    expect(await screen.findByText('SALES_SO')).toBeInTheDocument();
    expect(await screen.findByText('WHOLESALER')).toBeInTheDocument();
    expect(screen.getAllByText('By role')).toHaveLength(2);
    expect(screen.getAllByText('By OS')).toHaveLength(2);
    expect(screen.queryByText('ANDROID')).not.toBeInTheDocument();
    expect(screen.queryByText('By platform')).not.toBeInTheDocument();
  });

  it('AD3b: an older API without devices/byRole still renders the installed card', async () => {
    mockFetchOk({ ...PAYLOAD, installed: { users: 65, byPlatform: [{ platform: 'ANDROID', users: 65 }] } });
    render(<AppAdoptionPage />);
    expect((await screen.findAllByText('65')).length).toBeGreaterThanOrEqual(1);
    // Only the notifications card has a devices line when the API omits installed.devices.
    expect(screen.getAllByText(/^across .* devices$/)).toHaveLength(1);
  });

  it('AD4: shows the empty state when all counts are zero', async () => {
    mockFetchOk(ZERO_PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByTestId('app-adoption-empty')).toBeInTheDocument();
    expect(await screen.findByText('No installs or subscriptions yet')).toBeInTheDocument();
  });

  it('AD5: on fetch failure shows an error state and no fabricated numbers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<AppAdoptionPage />);

    expect(await screen.findByTestId('app-adoption-error')).toBeInTheDocument();
    expect(screen.queryByText('128')).not.toBeInTheDocument();
    expect(screen.queryByText('64')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  /** Adoption payload for GET /api/push/adoption; `download` answers the installed-users request. */
  function mockFetchRoutes(download: (url: string) => Promise<unknown>) {
    const fetchMock = vi.fn((url: string) =>
      String(url).startsWith('/api/push/adoption/installed-users')
        ? download(String(url))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PAYLOAD) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const fileResponse = () => ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'Content-Disposition' ? 'attachment; filename="app-installed-users-2026-11-16.xlsx"' : null) },
    blob: () => Promise.resolve(new Blob(['x'])),
  });

  it('AD6: shows the download button and the "installed app" note', async () => {
    mockFetchRoutes(() => Promise.resolve(fileResponse()));
    render(<AppAdoptionPage />);
    expect(await screen.findByRole('button', { name: /Download installed users \(Excel\)/ })).toBeEnabled();
    expect(screen.getByText('Includes everyone who opened the app as an installed app.')).toBeInTheDocument();
  });

  it('AD7: sends the chosen filters, shows a loading state, then saves the file', async () => {
    let resolveDownload: (v: unknown) => void = () => {};
    const fetchMock = mockFetchRoutes(() => new Promise((r) => { resolveDownload = r; }));
    render(<AppAdoptionPage />);
    const button = await screen.findByRole('button', { name: /Download installed users/ });

    fireEvent.change(screen.getByLabelText('Role group'), { target: { value: 'partner' } });
    fireEvent.change(screen.getByLabelText('Installed since (optional)'), { target: { value: '2026-11-01' } });
    fireEvent.click(button);

    // Loading: busy label + disabled while the request is in flight.
    expect(await screen.findByRole('button', { name: /Preparing/ })).toBeDisabled();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('installed-users'))!;
    expect(call[0]).toBe('/api/push/adoption/installed-users?roleGroup=partner&since=2026-11-01');

    resolveDownload(fileResponse());
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'app-installed-users-2026-11-16.xlsx'));
    expect(await screen.findByRole('button', { name: /Download installed users/ })).toBeEnabled();
    expect(screen.queryByTestId('download-error')).not.toBeInTheDocument();
  });

  it('AD8: a server refusal shows a readable error (never silent) and no file is saved', async () => {
    mockFetchRoutes(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ success: false, error: 'Access denied. Required: GIFSY_ADMIN or CLIENT_ADMIN or MIS_USER.' }),
      }),
    );
    render(<AppAdoptionPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Download installed users/ }));
    const err = await screen.findByTestId('download-error');
    expect(err).toHaveTextContent('Access denied');
    expect(err).toHaveAttribute('role', 'alert');
    expect(downloadBlob).not.toHaveBeenCalled();
    // The adoption numbers stay on screen.
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('AD9: a network failure shows a readable error', async () => {
    mockFetchRoutes(() => Promise.reject(new Error('offline')));
    render(<AppAdoptionPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Download installed users/ }));
    expect(await screen.findByTestId('download-error')).toHaveTextContent("Couldn't reach the server");
  });

  it('AD10: nobody installed → the download panel is disabled with a short reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(ZERO_PAYLOAD) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AppAdoptionPage />);
    const button = await screen.findByRole('button', { name: /Download installed users/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('No one has installed the app yet, so there is nothing to download.');
    expect(screen.getByLabelText('Role group')).toBeDisabled();
    expect(screen.getByLabelText('Installed since (optional)')).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('installed-users'))).toBe(false);
  });

  it('AD11: filters that match nobody → "0 users matched these filters" (neutral), no file saved, no error', async () => {
    mockFetchRoutes(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ success: false, error: '0 users matched these filters.' }),
      }),
    );
    render(<AppAdoptionPage />);
    fireEvent.change(await screen.findByLabelText('Role group'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: /Download installed users/ }));
    await waitFor(() => expect(screen.getByTestId('installed-users-no-match')).toHaveTextContent('0 users matched these filters.'));
    expect(screen.getByTestId('installed-users-no-match')).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('download-error')).not.toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Download installed users/ })).toBeEnabled();
    // Changing a filter clears the note.
    fireEvent.change(screen.getByLabelText('Role group'), { target: { value: '' } });
    expect(screen.getByTestId('installed-users-no-match')).toHaveTextContent('');
  });

  it('AD12: visible labels ARE the accessible names (no differing aria-labels)', async () => {
    mockFetchRoutes(() => Promise.resolve(fileResponse()));
    render(<AppAdoptionPage />);
    expect(await screen.findByRole('combobox', { name: 'Role group' })).not.toHaveAttribute('aria-label');
    expect(screen.getByLabelText('Installed since (optional)')).not.toHaveAttribute('aria-label');
  });
});
