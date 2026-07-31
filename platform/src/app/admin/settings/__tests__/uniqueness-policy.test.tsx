/// <reference types="vitest/globals" />
/**
 * Identity & Payout Uniqueness — Settings card (per-tenant, GIFSY_ADMIN only)
 *
 * `uniquenessPolicy` = { gst, phone, bank, upi } is a REPLACE-WHOLE nested key: every toggle
 * saves the COMPLETE object via saveGifsySettings({ uniquenessPolicy }). PAN + GST are always-on
 * golden keys (rendered as an "Always on" pill, never a toggle). GIFSY_ADMIN-only to edit.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let mockRole: 'GIFSY_ADMIN' | 'CLIENT_ADMIN' = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return { ...actual, getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }) };
});
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

function stubFetch(uniquenessPolicy: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/admin/settings') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { settings: { uniquenessPolicy } } }),
        });
      }
      return Promise.reject(new Error('no server in test'));
    }),
  );
}

describe('Identity & Payout Uniqueness settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (saveGifsySettings as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  it('renders PAN/GST as always-on and seeds the editable toggles from stored policy', async () => {
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    // PAN + GST are always-on golden keys.
    expect((await screen.findByTestId('uniq-pan')).textContent).toContain('Always on');
    expect(screen.getByTestId('uniq-gst').textContent).toContain('Always on');
    // Bank seeded OFF → the OFF segment is selected.
    await waitFor(() => expect(screen.getByTestId('uniq-bank-off')).toHaveAttribute('aria-checked', 'true'));
  });

  it('turning bank ON saves the WHOLE uniquenessPolicy object (gst stays true)', async () => {
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    const bankOn = await screen.findByTestId('uniq-bank-on');
    fireEvent.click(bankOn);
    await waitFor(() =>
      expect(saveGifsySettings).toHaveBeenCalledWith({
        uniquenessPolicy: { gst: true, phone: true, bank: true, upi: false },
      }),
    );
  });

  it('disables the editable toggles for a non-GIFSY admin', async () => {
    mockRole = 'CLIENT_ADMIN';
    stubFetch({ gst: true, phone: true, bank: false, upi: false });
    render(<SettingsPage />);
    expect(await screen.findByTestId('uniq-bank-on')).toBeDisabled();
    expect(screen.getByTestId('uniq-upi-on')).toBeDisabled();
  });
});
