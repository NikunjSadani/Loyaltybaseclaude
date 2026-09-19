/// <reference types="vitest/globals" />
/**
 * Platform-global settings mirrored onto the OPERATOR settings page (/gifsy/settings).
 *
 * The two platform-global cards — Report Recipients and the National Holiday Calendar — now
 * render on the operator page as well as /admin/settings. Both edit the SAME server settings via
 * @/lib/report-recipients and @/lib/holidays; both WRITE GIFSY_ADMIN-only. The page resolves the
 * role from getStoredUser() and only loads/edits the cards for a Gifsy Admin.
 *
 * P1: both cards render for a GIFSY_ADMIN
 * P2: adding a KYC-actionables recipient + Save calls saveReportRecipients with the new address
 * P3: Save is disabled until the data has loaded AND is valid
 * P4: adding a holiday row + Save calls saveHolidays with the row
 * P5: a non-GIFSY_ADMIN operator sees neither editable card (read-only note, no fetch)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mutable role for the mocked session — set per-test before rendering.
let mockRole: 'GIFSY_ADMIN' | 'GIFSY_STAFF' = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Admin', role: mockRole, phone: '900' }),
  };
});

// The redemption-thresholds card persists via the api client; no-op it so nothing hits a server.
vi.mock('@/lib/api-client', () => ({
  authHeader: () => ({}),
  api: {
    get: vi.fn().mockResolvedValue({ success: false, error: 'no server in test' }),
    put: vi.fn().mockResolvedValue({ success: true, data: {} }),
    post: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
}));

// Control the report-recipients GET/PUT directly.
vi.mock('@/lib/report-recipients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/report-recipients')>();
  return {
    ...actual,
    fetchReportRecipients: vi.fn(),
    saveReportRecipients: vi.fn(),
  };
});

// Control the holidays GET/PUT directly.
vi.mock('@/lib/holidays', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/holidays')>();
  return {
    ...actual,
    fetchHolidays: vi.fn(),
    saveHolidays: vi.fn(),
  };
});

import GifsySettingsPage from '../page';
import { fetchReportRecipients, saveReportRecipients } from '@/lib/report-recipients';
import { fetchHolidays, saveHolidays } from '@/lib/holidays';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('Operator settings — platform-global cards', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    asMock(fetchReportRecipients).mockResolvedValue({
      creditsPayouts: ['finance@acme.test', 'ops@acme.test'],
      kycActionables: ['kyc@acme.test'],
    });
    asMock(saveReportRecipients).mockResolvedValue(true);
    asMock(fetchHolidays).mockResolvedValue([]);
    asMock(saveHolidays).mockResolvedValue(true);
  });

  it('P1: both platform-global cards render for a GIFSY_ADMIN', async () => {
    render(<GifsySettingsPage />);
    expect(screen.getByTestId('report-recipients-card')).toBeInTheDocument();
    expect(screen.getByTestId('holiday-calendar-card')).toBeInTheDocument();
    // The fetched credits recipients hydrate into editable inputs.
    await waitFor(() => {
      const credits = screen.getAllByTestId('recipient-input-creditsPayouts') as HTMLInputElement[];
      expect(credits.map((el) => el.value)).toEqual(['finance@acme.test', 'ops@acme.test']);
    });
  });

  it('P2: adding a KYC recipient + Save calls saveReportRecipients with the new address', async () => {
    render(<GifsySettingsPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('recipient-input-kycActionables')).toHaveLength(1),
    );

    fireEvent.click(screen.getByTestId('recipient-add-kycActionables'));
    const kycInputs = screen.getAllByTestId('recipient-input-kycActionables') as HTMLInputElement[];
    expect(kycInputs).toHaveLength(2);
    fireEvent.change(kycInputs[1], { target: { value: 'new@kyc.test' } });

    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => {
      expect(saveReportRecipients).toHaveBeenCalledWith({
        creditsPayouts: ['finance@acme.test', 'ops@acme.test'],
        kycActionables: ['kyc@acme.test', 'new@kyc.test'],
      });
    });
  });

  it('P3: Save is disabled until data is loaded AND valid', async () => {
    // Hold the recipients fetch unresolved so the card stays in its loading state.
    let resolveFetch!: (v: { creditsPayouts: string[]; kycActionables: string[] }) => void;
    asMock(fetchReportRecipients).mockReturnValue(
      new Promise((res) => { resolveFetch = res; }),
    );
    render(<GifsySettingsPage />);

    // Before the fetch resolves there is no Save button (card shows "Loading recipients…").
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();

    // Resolve → the editable card + Save appear, enabled (loaded + valid).
    resolveFetch({ creditsPayouts: ['finance@acme.test'], kycActionables: [] });
    const save = await screen.findByTestId('recipients-save');
    await waitFor(() => expect(save).not.toBeDisabled());

    // Add an empty recipient row → invalid → Save disabled again.
    fireEvent.click(screen.getByTestId('recipient-add-creditsPayouts'));
    await waitFor(() => expect(screen.getByTestId('recipients-save')).toBeDisabled());
  });

  it('P4: adding a holiday row + Save calls saveHolidays with the row', async () => {
    render(<GifsySettingsPage />);
    await screen.findByTestId('holiday-add');

    fireEvent.click(screen.getByTestId('holiday-add'));
    fireEvent.change(screen.getByTestId('holiday-date-input'), { target: { value: '2026-01-26' } });
    fireEvent.change(screen.getByTestId('holiday-label-input'), { target: { value: 'Republic Day' } });

    await waitFor(() => expect(screen.getByTestId('holiday-save')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('holiday-save'));
    await waitFor(() => {
      expect(saveHolidays).toHaveBeenCalledWith([{ date: '2026-01-26', label: 'Republic Day' }]);
    });
  });

  it('P5: a non-GIFSY_ADMIN operator sees no editable card and never fetches', async () => {
    mockRole = 'GIFSY_STAFF';
    render(<GifsySettingsPage />);
    // The card containers still render (with a read-only note), but no inputs / Save / fetch.
    await screen.findByTestId('report-recipients-card');
    expect(screen.queryByTestId('recipient-input-creditsPayouts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-save')).not.toBeInTheDocument();
    expect(fetchReportRecipients).not.toHaveBeenCalled();
    expect(fetchHolidays).not.toHaveBeenCalled();
  });
});
