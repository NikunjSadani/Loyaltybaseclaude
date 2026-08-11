/// <reference types="vitest/globals" />
/**
 * National Holiday Calendar — Settings card (platform-global)
 *
 * The holiday calendar drives the KYC business-hours SLA clock. It is read from
 * GET /api/admin/settings/holidays (GIFSY_ADMIN + CLIENT_ADMIN may read) and written via
 * PUT /api/admin/settings/holidays (GIFSY_ADMIN-only — the backend 403s others), both through
 * the @/lib/holidays client. A GIFSY_ADMIN may add/remove/edit rows + Save; a CLIENT_ADMIN sees
 * the list READ-ONLY (no date input, no add, no Save).
 *
 * H1: card renders and lists the fetched holidays (date + label)
 * H2: GIFSY_ADMIN Save calls saveHolidays(<the list>)
 * H3: CLIENT_ADMIN sees the values but cannot edit (no date input / add / Save)
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

// Control the holiday calendar GET/PUT directly.
vi.mock('@/lib/holidays', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/holidays')>();
  return {
    ...actual,
    fetchHolidays: vi.fn().mockResolvedValue([
      { date: '2026-01-26', label: 'Republic Day' },
      { date: '2026-08-15', label: 'Independence Day' },
    ]),
    saveHolidays: vi.fn().mockResolvedValue(true),
  };
});

// KYC SLA fetches on mount — keep it resolved so the page doesn't hang.
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
import { fetchHolidays, saveHolidays } from '@/lib/holidays';

describe('National Holiday Calendar settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (fetchHolidays as ReturnType<typeof vi.fn>).mockResolvedValue([
      { date: '2026-01-26', label: 'Republic Day' },
      { date: '2026-08-15', label: 'Independence Day' },
    ]);
    (saveHolidays as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Other libs (task-config, visibility-capture-mode) fetch on mount — fail global fetch
    // so they resolve to defaults without a server.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('H1: renders the card and lists the fetched holidays', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('holiday-calendar-card')).toBeInTheDocument();
    // GIFSY_ADMIN: labels are shown in editable inputs bound to the fetched values.
    await waitFor(() => {
      const labels = screen.getAllByTestId('holiday-label-input') as HTMLInputElement[];
      expect(labels.map((el) => el.value)).toEqual(['Republic Day', 'Independence Day']);
    });
  });

  it('H2: GIFSY_ADMIN Save calls saveHolidays with the list', async () => {
    render(<SettingsPage />);
    await screen.findByTestId('holiday-save');
    await waitFor(() =>
      expect(screen.getAllByTestId('holiday-label-input')).toHaveLength(2),
    );
    fireEvent.click(screen.getByTestId('holiday-save'));
    await waitFor(() => {
      expect(saveHolidays).toHaveBeenCalledWith([
        { date: '2026-01-26', label: 'Republic Day' },
        { date: '2026-08-15', label: 'Independence Day' },
      ]);
    });
  });

  it('H3: CLIENT_ADMIN sees the values but cannot edit (read-only)', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    expect(await screen.findByText('Republic Day')).toBeInTheDocument();
    expect(screen.getByText('Independence Day')).toBeInTheDocument();
    // No editing affordances for a tenant admin.
    expect(screen.queryByTestId('holiday-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-date-input')).not.toBeInTheDocument();
    expect(saveHolidays).not.toHaveBeenCalled();
  });
});
