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
// Mutable assumed-tenant brand — null = platform (un-assumed) mode (the default). Set to a
// brand name to simulate a GIFSY operator assumed into a tenant, which hides platform-global cards.
let mockAssumedBrand: string | null = null;
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }),
    getAssumedBrand: () => mockAssumedBrand,
  };
});

// Assumed-tenant signal (server action). Default un-assumed; a test flips mockAssumedBrand
// to exercise the assumed path. Mocked wholesale so the real 'use server' module (next/headers)
// never loads in jsdom.
vi.mock('@/lib/auth-actions', () => ({
  getAssumedContext: vi.fn(async () => ({ brandName: mockAssumedBrand })),
}));

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
import { fetchReportRecipients, saveReportRecipients } from '@/lib/report-recipients';
import { getAssumedContext } from '@/lib/auth-actions';

describe('Report Recipients settings card', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    mockAssumedBrand = null;
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

  it('R4: a GIFSY_ADMIN assumed into a tenant sees the PLACEHOLDER (not the editable card, not nothing)', async () => {
    mockRole = 'GIFSY_ADMIN';
    mockAssumedBrand = 'Deoleo'; // operator is assumed into a tenant
    render(<SettingsPage />);
    // The holiday card renders for everyone — use it to let the page settle.
    await screen.findByTestId('holiday-calendar-card');
    // While assumed: the placeholder is shown, the editable card + inputs are NOT.
    await waitFor(() =>
      expect(screen.getByTestId('report-recipients-placeholder')).toBeInTheDocument(),
    );
    expect(screen.getByText(/exit the tenant to manage them/i)).toBeInTheDocument();
    expect(screen.queryByTestId('report-recipients-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipient-input-creditsPayouts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();
    // Security & Platform Config shows its placeholder too (platform-global, hidden while assumed).
    expect(screen.getByTestId('security-config-placeholder')).toBeInTheDocument();
    expect(screen.getByText(/exit the tenant to view\/manage/i)).toBeInTheDocument();
  });

  it('R5: in platform (un-assumed) mode the card is the full editable card (no placeholder)', async () => {
    mockRole = 'GIFSY_ADMIN';
    mockAssumedBrand = null; // platform mode
    render(<SettingsPage />);
    expect(await screen.findByTestId('report-recipients-card')).toBeInTheDocument();
    // Editable: the email inputs render bound to the fetched values, plus the Save button.
    await waitFor(() =>
      expect(screen.getAllByTestId('recipient-input-creditsPayouts')).toHaveLength(2),
    );
    expect(screen.getByTestId('recipients-save')).toBeInTheDocument();
    // No placeholder in platform mode.
    expect(screen.queryByTestId('report-recipients-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('security-config-placeholder')).not.toBeInTheDocument();
  });

  it('R6: a cross-tab Exit (storage/focus) un-hides the editable card without a remount', async () => {
    mockRole = 'GIFSY_ADMIN';
    mockAssumedBrand = 'Deoleo'; // start assumed → placeholder
    render(<SettingsPage />);
    await screen.findByTestId('holiday-calendar-card');
    await waitFor(() =>
      expect(screen.getByTestId('report-recipients-placeholder')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('report-recipients-card')).not.toBeInTheDocument();

    // Operator Exits to platform in ANOTHER tab: the localStorage hint clears and the
    // server reconcile now reports platform level. Simulate the cross-tab signals WITHOUT
    // re-rendering/remounting the settings page.
    mockAssumedBrand = null;
    fireEvent(window, new Event('storage')); // sync hint re-read
    fireEvent(window, new Event('focus'));    // full server reconcile

    // The SAME mounted page swaps the placeholder for the full editable card.
    await waitFor(() =>
      expect(screen.getByTestId('report-recipients-card')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('report-recipients-placeholder')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId('recipient-input-creditsPayouts')).toHaveLength(2),
    );
    expect(screen.getByTestId('recipients-save')).toBeInTheDocument();
    // Security placeholder is gone too, back to platform level.
    expect(screen.queryByTestId('security-config-placeholder')).not.toBeInTheDocument();
  });

  it('R7: a stale hint (server says un-assumed) is scrubbed on reconcile, so it can\'t re-flip the card', async () => {
    mockRole = 'GIFSY_ADMIN';
    // Stale localStorage hint present AND the optimistic read sees it (assumed → placeholder first)…
    localStorage.setItem('assumedBrand', 'Deoleo');
    mockAssumedBrand = 'Deoleo';
    // …but SERVER TRUTH says un-assumed (assumed token expired / a failed exit left the hint).
    (getAssumedContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ brandName: null });
    render(<SettingsPage />);
    // Reconcile clears the stale hint itself (no dependency on the OperatorBanner being mounted),
    // so a later cross-tab 'storage' event can't re-read it and flip back to the placeholder.
    await waitFor(() => expect(localStorage.getItem('assumedBrand')).toBeNull());
    // And the editable card is shown (platform level).
    await waitFor(() =>
      expect(screen.getByTestId('report-recipients-card')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('report-recipients-placeholder')).not.toBeInTheDocument();
  });
});
