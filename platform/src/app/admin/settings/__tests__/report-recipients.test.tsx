/// <reference types="vitest/globals" />
/**
 * Report Recipients — Settings card (platform-global)
 *
 * The report-recipient lists drive who receives the scheduled internal reports (the daily
 * Mon–Sat operator digests). Both GET and PUT of /api/admin/settings/report-recipients are
 * GIFSY_ADMIN-only (the list is Gifsy's internal ops distribution list — no tenant-admin
 * relevance), through the @/lib/report-recipients client. The whole card renders only for a
 * Gifsy Admin; a CLIENT_ADMIN never sees it (and the page never even fetches the list).
 *
 * R1: card renders and lists the two fetched recipient lists (GIFSY_ADMIN)
 * R2: GIFSY_ADMIN Save calls saveReportRecipients(<the lists>)
 * R3: CLIENT_ADMIN never sees the card, and the list is not fetched
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

// Control the report-recipients GET/PUT directly.
vi.mock('@/lib/report-recipients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/report-recipients')>();
  return {
    ...actual,
    fetchReportRecipients: vi.fn().mockResolvedValue({
      creditsPayouts: ['finance@acme.test', 'ops@acme.test'],
      kycActionables: ['kyc@acme.test'],
    }),
    saveReportRecipients: vi.fn().mockResolvedValue(true),
  };
});

// Holiday calendar fetches on mount — keep it resolved so the page doesn't hang.
vi.mock('@/lib/holidays', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/holidays')>();
  return {
    ...actual,
    fetchHolidays: vi.fn().mockResolvedValue([]),
    saveHolidays: vi.fn().mockResolvedValue(true),
  };
});

// KYC SLA fetches on mount — keep it resolved so the page doesn't hang.
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
import { fetchReportRecipients, saveReportRecipients } from '@/lib/report-recipients';

describe('Report Recipients settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    (fetchReportRecipients as ReturnType<typeof vi.fn>).mockResolvedValue({
      creditsPayouts: ['finance@acme.test', 'ops@acme.test'],
      kycActionables: ['kyc@acme.test'],
    });
    (saveReportRecipients as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Other libs (task-config, visibility-capture-mode) fetch on mount — fail global fetch
    // so they resolve to defaults without a server.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server in test')));
  });

  it('R1: renders the card and lists both fetched recipient lists', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('report-recipients-card')).toBeInTheDocument();
    // GIFSY_ADMIN: emails are shown in editable inputs bound to the fetched values.
    await waitFor(() => {
      const credits = screen.getAllByTestId('recipient-input-creditsPayouts') as HTMLInputElement[];
      expect(credits.map((el) => el.value)).toEqual(['finance@acme.test', 'ops@acme.test']);
    });
    const kyc = screen.getAllByTestId('recipient-input-kycActionables') as HTMLInputElement[];
    expect(kyc.map((el) => el.value)).toEqual(['kyc@acme.test']);
  });

  it('R2: GIFSY_ADMIN Save calls saveReportRecipients with the lists', async () => {
    render(<SettingsPage />);
    await screen.findByTestId('recipients-save');
    await waitFor(() =>
      expect(screen.getAllByTestId('recipient-input-creditsPayouts')).toHaveLength(2),
    );
    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => {
      expect(saveReportRecipients).toHaveBeenCalledWith({
        creditsPayouts: ['finance@acme.test', 'ops@acme.test'],
        kycActionables: ['kyc@acme.test'],
      });
    });
  });

  it('R3: CLIENT_ADMIN never sees the card, and the list is not fetched', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<SettingsPage />);
    // Let the page settle — the holiday card renders for both roles; the recipients card must not.
    await screen.findByTestId('holiday-calendar-card');
    expect(screen.queryByTestId('report-recipients-card')).not.toBeInTheDocument();
    expect(screen.queryByText('finance@acme.test')).not.toBeInTheDocument();
    // GIFSY-only endpoint — a tenant admin should not even request it.
    expect(fetchReportRecipients).not.toHaveBeenCalled();
    expect(saveReportRecipients).not.toHaveBeenCalled();
  });
});
