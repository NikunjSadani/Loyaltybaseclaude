/// <reference types="vitest/globals" />
/**
 * KYC SLA Configuration — Settings card (per-tenant)
 *
 * KYC SLA is now TWO business-hours targets — the Field SLA (`fieldSlaTargetHours`, 24) and
 * the Gifsy SLA (`gifsySlaTargetHours`, 96) — read from GET /api/admin/settings and written
 * via saveKycSlaTargets (PUT /api/admin/settings per key) — GIFSY_ADMIN-only. The card shows
 * both current values; a GIFSY_ADMIN may edit + Save. CLIENT_ADMIN may view the values but the
 * inputs are disabled and Save is hidden.
 *
 * K1: card renders; both loaded values bind to their inputs (field 24 / gifsy 96)
 * K2: GIFSY_ADMIN saving valid numbers calls saveKycSlaTargets({ fieldHrs, gifsyHrs })
 * K3: an out-of-range value is blocked client-side (no save)
 * K4: CLIENT_ADMIN sees the values but both inputs are disabled and Save is hidden
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

// Control the KYC SLA GET/PUT directly.
vi.mock('@/lib/kyc-sla', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kyc-sla')>();
  return {
    ...actual,
    fetchKycSlaTargets: vi.fn().mockResolvedValue({ fieldHrs: 24, gifsyHrs: 96 }),
    saveKycSlaTargets: vi.fn().mockResolvedValue(true),
  };
});

// Points-expiry fetches on mount — keep it resolved so the page doesn't hang.
vi.mock('@/lib/points-expiry', () => ({
  fetchPointsExpiry: vi.fn().mockResolvedValue({ pointsExpiryDays: null }),
  savePointsExpiry: vi.fn().mockResolvedValue(true),
}));

// Keep gifsy-settings real (defaults seed unrelated cards) but stub the save.
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: vi.fn().mockResolvedValue(true) };
});

import SettingsPage from '../page';
import { fetchKycSlaTargets, saveKycSlaTargets } from '@/lib/kyc-sla';

describe('KYC SLA settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (fetchKycSlaTargets as ReturnType<typeof vi.fn>).mockResolvedValue({ fieldHrs: 24, gifsyHrs: 96 });
    (saveKycSlaTargets as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Other libs (task-config, visibility-capture-mode) fetch on mount — fail global fetch
    // so they resolve to defaults without a server.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('K1: renders the card and binds both loaded SLA values', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('kyc-sla-card')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('kyc-sla-field-input')).toHaveValue(24);
      expect(screen.getByTestId('kyc-sla-gifsy-input')).toHaveValue(96);
    });
  });

  it('K2: GIFSY_ADMIN saving valid numbers calls saveKycSlaTargets({ fieldHrs, gifsyHrs })', async () => {
    render(<SettingsPage />);
    const field = await screen.findByTestId('kyc-sla-field-input');
    const gifsy = await screen.findByTestId('kyc-sla-gifsy-input');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: '36' } });
    fireEvent.change(gifsy, { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('kyc-sla-save'));
    await waitFor(() => {
      expect(saveKycSlaTargets).toHaveBeenCalledWith({ fieldHrs: 36, gifsyHrs: 72 });
    });
  });

  it('K3: an out-of-range value is blocked client-side (no save)', async () => {
    render(<SettingsPage />);
    const field = await screen.findByTestId('kyc-sla-field-input');
    const gifsy = await screen.findByTestId('kyc-sla-gifsy-input');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: '500' } }); // > 168
    fireEvent.change(gifsy, { target: { value: '96' } });
    fireEvent.click(screen.getByTestId('kyc-sla-save'));
    await waitFor(() => {
      expect(screen.getByText(/between 1 and 168/i)).toBeInTheDocument();
    });
    expect(saveKycSlaTargets).not.toHaveBeenCalled();
  });

  it('K4: CLIENT_ADMIN sees the values but cannot edit (inputs disabled, Save hidden)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    const field = await screen.findByTestId('kyc-sla-field-input');
    const gifsy = await screen.findByTestId('kyc-sla-gifsy-input');
    await waitFor(() => expect(field).toHaveValue(24));
    expect(gifsy).toHaveValue(96);
    expect(field).toBeDisabled();
    expect(gifsy).toBeDisabled();
    expect(screen.queryByTestId('kyc-sla-save')).not.toBeInTheDocument();
  });
});
