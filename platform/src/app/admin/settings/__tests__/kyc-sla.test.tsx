/// <reference types="vitest/globals" />
/**
 * KYC SLA Configuration — Settings card (per-tenant)
 *
 * The KYC SLA target (working hours from submission to approval/rejection) is read from
 * GET /api/admin/settings (settings.slaTargetHours) and written via PUT /api/admin/settings
 * { key: 'slaTargetHours', value } — GIFSY_ADMIN-only. The saved value drives the breach
 * count on the KYC SLA KPI dashboard. The card shows the current value; a GIFSY_ADMIN may
 * edit + Save. CLIENT_ADMIN may view the value but the input is disabled and Save is hidden.
 *
 * K1: card renders; the loaded value is shown in the input (binds to slaTargetHours)
 * K2: GIFSY_ADMIN saving a valid number calls saveKycSlaHours(<number>)
 * K3: an out-of-range value is blocked client-side (no save)
 * K4: CLIENT_ADMIN sees the value but the input is disabled and Save is hidden
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

// Control the KYC SLA GET/PUT directly.
vi.mock('@/lib/kyc-sla', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kyc-sla')>();
  return {
    ...actual,
    fetchKycSlaHours: vi.fn().mockResolvedValue(96),
    saveKycSlaHours: vi.fn().mockResolvedValue(true),
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
import { fetchKycSlaHours, saveKycSlaHours } from '@/lib/kyc-sla';

describe('KYC SLA settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (fetchKycSlaHours as ReturnType<typeof vi.fn>).mockResolvedValue(96);
    (saveKycSlaHours as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Other libs (task-config, visibility-capture-mode) fetch on mount — fail global fetch
    // so they resolve to defaults without a server.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('K1: renders the card and binds the loaded slaTargetHours value', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('kyc-sla-card')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('kyc-sla-input')).toHaveValue(96);
    });
  });

  it('K2: GIFSY_ADMIN saving a valid number calls saveKycSlaHours(<number>)', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('kyc-sla-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '72' } });
    fireEvent.click(screen.getByTestId('kyc-sla-save'));
    await waitFor(() => {
      expect(saveKycSlaHours).toHaveBeenCalledWith(72);
    });
  });

  it('K3: an out-of-range value is blocked client-side (no save)', async () => {
    render(<SettingsPage />);
    const input = await screen.findByTestId('kyc-sla-input');
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '500' } }); // > 168
    fireEvent.click(screen.getByTestId('kyc-sla-save'));
    await waitFor(() => {
      expect(screen.getByText(/between 1 and 168/i)).toBeInTheDocument();
    });
    expect(saveKycSlaHours).not.toHaveBeenCalled();
  });

  it('K4: CLIENT_ADMIN sees the value but cannot edit (input disabled, Save hidden)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    const input = await screen.findByTestId('kyc-sla-input');
    await waitFor(() => expect(input).toHaveValue(96));
    expect(input).toBeDisabled();
    expect(screen.queryByTestId('kyc-sla-save')).not.toBeInTheDocument();
  });
});
