/// <reference types="vitest/globals" />
/**
 * Points → ₹ Conversion Rate — Settings card (per-tenant)
 *
 * The per-tenant conversion rate is read synchronously from getGifsySettings().pointsConversionRate
 * (defaults to 1) and written via saveGifsySettings({ pointsConversionRate }) which PUTs
 * /v1/admin/settings (GIFSY_ADMIN-only). A GIFSY_ADMIN may edit + Save; CLIENT_ADMIN sees the value
 * but the input is disabled and the Save button is hidden. The backend read-layer floor is
 * MIN_RATE = 0.005, so the UI blocks a save of any value below that.
 *
 * C1: card renders; the input shows the default loaded value 1
 * C2: GIFSY_ADMIN saving 2 calls saveGifsySettings({ pointsConversionRate: 2 })
 * C3: GIFSY_ADMIN entering 0 shows an error and does NOT call saveGifsySettings (below floor)
 * C4: CLIENT_ADMIN sees the value but the input is disabled and Save is hidden
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mutable role for the mocked session — set per-test before rendering.
let mockRole: 'GIFSY_ADMIN' | 'CLIENT_ADMIN' = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }),
  };
});

// Other libs (points-expiry, task-config, visibility-capture-mode) fetch on mount —
// keep gifsy-settings real (defaults seed this card's value) and override the write, and
// fail global fetch so the others resolve to defaults without a server.
vi.mock('@/lib/points-expiry', () => ({
  fetchPointsExpiry: vi.fn().mockResolvedValue({ pointsExpiryDays: 90 }),
  savePointsExpiry: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: vi.fn().mockResolvedValue(true) };
});

import SettingsPage from '../page';
import { saveGifsySettings } from '@/lib/gifsy-settings';

describe('Conversion Rate settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('C1: renders the card and shows the default loaded value 1', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('conversion-rate-card')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('conversion-rate-input')).toHaveValue(1);
    });
  });

  it('C2: GIFSY_ADMIN saving 2 calls saveGifsySettings({ pointsConversionRate: 2 })', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('conversion-rate-save'));
    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith({ pointsConversionRate: 2 });
    });
  });

  it('C3: entering 0 shows an error and does NOT save (below the 0.005 floor)', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('conversion-rate-save'));
    await waitFor(() => {
      expect(screen.getByText(/between 0\.005 and 100000/)).toBeInTheDocument();
    });
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('C5: entering 0.004 (in the (0,0.005) danger band) shows an error and does NOT save', async () => {
    // Guards the EXACT floor: a value the backend read-layer would silently ignore (keeping the
    // default) must be blocked in the UI. A weaker test using 0 would pass even if the floor
    // check were loosened to `<= 0`; 0.004 pins the 0.005 boundary.
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '0.004' } });
    fireEvent.click(screen.getByTestId('conversion-rate-save'));
    await waitFor(() => {
      expect(screen.getByText(/between 0\.005 and 100000/)).toBeInTheDocument();
    });
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('C6: saves the centi-snapped value (1.234 → 1.23) so display == what redemptions enforce', async () => {
    // The money path snapshots Math.round(rate*100) centi-units, so a sub-centi input is snapped
    // on save; the persisted + displayed value must match the enforced rate (no silent drift).
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '1.234' } });
    fireEvent.click(screen.getByTestId('conversion-rate-save'));
    await waitFor(() => {
      expect(saveGifsySettings).toHaveBeenCalledWith({ pointsConversionRate: 1.23 });
    });
    // The input reflects the snapped value the operator will actually be enforcing.
    expect(input).toHaveValue(1.23);
  });

  it('C7: rejects an absurd value above the ceiling (fat-finger guard) and does NOT save', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '9999999' } });
    fireEvent.click(screen.getByTestId('conversion-rate-save'));
    await waitFor(() => {
      expect(screen.getByText(/between 0\.005 and 100000/)).toBeInTheDocument();
    });
    expect(saveGifsySettings).not.toHaveBeenCalled();
  });

  it('C4: CLIENT_ADMIN sees the value but cannot edit (input disabled, Save hidden)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    const input = await screen.findByTestId('conversion-rate-input');
    await waitFor(() => expect(input).toHaveValue(1));
    expect(input).toBeDisabled();
    expect(screen.queryByTestId('conversion-rate-save')).not.toBeInTheDocument();
  });
});
