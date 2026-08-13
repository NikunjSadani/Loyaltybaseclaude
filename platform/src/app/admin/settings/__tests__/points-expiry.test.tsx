/// <reference types="vitest/globals" />
/**
 * Points Expiry — Settings card (per-tenant default)
 *
 * The tenant-wide default points-expiry is read from GET /api/admin/settings/points-expiry
 * and written via PUT /api/admin/settings/points-expiry (GIFSY_ADMIN-only). The card shows the
 * current value (blank = never expire); a GIFSY_ADMIN may edit + Save. CLIENT_ADMIN may view the
 * value but the input is disabled and the Save button is hidden.
 *
 * P1: card renders; the loaded value is shown in the input
 * P2: GIFSY_ADMIN saving a number PUTs { pointsExpiryDays: <number> }
 * P3: GIFSY_ADMIN clearing the field PUTs { pointsExpiryDays: null } (never expire)
 * P4: CLIENT_ADMIN sees the value but the input is disabled and Save is hidden
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
    getAssumedBrand: () => null,
  };
});

// Un-assumed by default so the new platform-mode effect resolves to platform mode and never
// loads the real 'use server' auth-actions module (next/headers) in jsdom.
vi.mock('@/lib/auth-actions', () => ({
  getAssumedContext: vi.fn(async () => ({ brandName: null })),
}));

// Control the points-expiry GET/PUT directly.
vi.mock('@/lib/points-expiry', () => ({
  fetchPointsExpiry: vi.fn().mockResolvedValue({ pointsExpiryDays: 90 }),
  savePointsExpiry: vi.fn().mockResolvedValue(true),
}));

// Other libs (gifsy-settings, task-config, visibility-capture-mode) fetch on mount —
// keep gifsy-settings real (defaults seed unrelated cards) and fail global fetch so the
// others resolve to defaults without a server.
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: vi.fn().mockResolvedValue(true) };
});

import SettingsPage from '../page';
import { fetchPointsExpiry, savePointsExpiry } from '@/lib/points-expiry';

describe('Points Expiry settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (fetchPointsExpiry as ReturnType<typeof vi.fn>).mockResolvedValue({ pointsExpiryDays: 90 });
    (savePointsExpiry as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('P1: renders the card and shows the loaded value', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('points-expiry-card')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('points-expiry-input')).toHaveValue(90);
    });
  });

  it('P2: GIFSY_ADMIN saving a number PUTs { pointsExpiryDays: <number> }', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('points-expiry-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('points-expiry-save'));
    await waitFor(() => {
      expect(savePointsExpiry).toHaveBeenCalledWith(120);
    });
  });

  it('P3: clearing the field saves null (never expire)', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('points-expiry-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('points-expiry-save'));
    await waitFor(() => {
      expect(savePointsExpiry).toHaveBeenCalledWith(null);
    });
  });

  it('P4: CLIENT_ADMIN sees the value but cannot edit (input disabled, Save hidden)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    const input = await screen.findByTestId('points-expiry-input');
    await waitFor(() => expect(input).toHaveValue(90));
    expect(input).toBeDisabled();
    expect(screen.queryByTestId('points-expiry-save')).not.toBeInTheDocument();
  });
});
