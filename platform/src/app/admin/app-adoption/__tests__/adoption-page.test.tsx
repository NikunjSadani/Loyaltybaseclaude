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
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AppAdoptionPage from '../page';

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
    expect(screen.getByText('across 173 devices')).toBeInTheDocument();
  });

  it('AD2: renders a role breakdown row and an OS breakdown row', async () => {
    mockFetchOk(PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByText('PARTNER')).toBeInTheDocument();
    expect(screen.getByText('Android')).toBeInTheDocument();
  });

  it('AD3: renders installed user count + a platform breakdown row', async () => {
    mockFetchOk(PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByText('64')).toBeInTheDocument();
    expect(screen.getByText('ANDROID')).toBeInTheDocument();
  });

  it('AD4: shows the empty state when all counts are zero', async () => {
    mockFetchOk(ZERO_PAYLOAD);
    render(<AppAdoptionPage />);
    expect(await screen.findByTestId('app-adoption-empty')).toBeInTheDocument();
    expect(screen.getByText('No installs or subscriptions yet')).toBeInTheDocument();
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
});
