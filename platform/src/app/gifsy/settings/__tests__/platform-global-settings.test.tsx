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
 * P2: adding a Daily Operations Digest recipient + Save calls saveReportRecipients({ dailyDigest })
 * P2b: removing a row + Save sends the shorter list; a save failure shows an error
 * P2c: an empty list shows the "nobody gets the digest" hint; the retired per-report groups are gone
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
      dailyDigest: ['finance@acme.test', 'ops@acme.test'],
    });
    asMock(saveReportRecipients).mockResolvedValue(true);
    asMock(fetchHolidays).mockResolvedValue([]);
    asMock(saveHolidays).mockResolvedValue(true);
  });

  it('P1: both platform-global cards render for a GIFSY_ADMIN', async () => {
    render(<GifsySettingsPage />);
    expect(screen.getByTestId('report-recipients-card')).toBeInTheDocument();
    expect(screen.getByTestId('holiday-calendar-card')).toBeInTheDocument();
    // The fetched digest recipients hydrate into editable inputs.
    await waitFor(() => {
      const inputs = screen.getAllByTestId('recipient-input-dailyDigest') as HTMLInputElement[];
      expect(inputs.map((el) => el.value)).toEqual(['finance@acme.test', 'ops@acme.test']);
    });
    expect(screen.getByText('Daily Operations Digest')).toBeInTheDocument();
    expect(screen.getAllByText(/Platform-wide · applies to all tenants\./).length).toBeGreaterThan(0);
  });

  it('P2: adding a digest recipient + Save calls saveReportRecipients with the new address', async () => {
    render(<GifsySettingsPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId('recipient-input-dailyDigest')).toHaveLength(2),
    );

    fireEvent.click(screen.getByTestId('recipient-add-dailyDigest'));
    const inputs = screen.getAllByTestId('recipient-input-dailyDigest') as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    fireEvent.change(inputs[2], { target: { value: ' New@Ops.test ' } });

    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => {
      expect(saveReportRecipients).toHaveBeenCalledWith({
        dailyDigest: ['finance@acme.test', 'ops@acme.test', 'New@Ops.test'],
      });
    });
  });

  it('P2b: removing a row + Save sends the shorter list; a failed save shows an error', async () => {
    asMock(saveReportRecipients).mockResolvedValue(false);
    render(<GifsySettingsPage />);
    await waitFor(() => expect(screen.getAllByTestId('recipient-input-dailyDigest')).toHaveLength(2));
    fireEvent.click(screen.getByLabelText('Remove finance@acme.test'));
    expect(screen.getAllByTestId('recipient-input-dailyDigest')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => expect(saveReportRecipients).toHaveBeenCalledWith({ dailyDigest: ['ops@acme.test'] }));
    expect(await screen.findByText('Could not save the report recipients — please try again.')).toBeInTheDocument();
  });

  it('P2c: an empty list shows the hint; the retired per-report groups are gone', async () => {
    asMock(fetchReportRecipients).mockResolvedValue({ dailyDigest: [] });
    render(<GifsySettingsPage />);
    expect(await screen.findByText(/Nobody gets the digest until you do/)).toBeInTheDocument();
    expect(screen.queryByTestId('recipients-group-creditsPayouts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-group-kycActionables')).not.toBeInTheDocument();
    expect(screen.queryByText('Credits & Payouts summary')).not.toBeInTheDocument();
  });

  it('P3: Save is disabled until data is loaded AND valid', async () => {
    // Hold the recipients fetch unresolved so the card stays in its loading state.
    let resolveFetch!: (v: { dailyDigest: string[] }) => void;
    asMock(fetchReportRecipients).mockReturnValue(
      new Promise((res) => { resolveFetch = res; }),
    );
    render(<GifsySettingsPage />);

    // Before the fetch resolves there is no Save button (card shows "Loading recipients…").
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();

    // Resolve → the editable card + Save appear, enabled (loaded + valid).
    resolveFetch({ dailyDigest: ['finance@acme.test'] });
    const save = await screen.findByTestId('recipients-save');
    await waitFor(() => expect(save).not.toBeDisabled());

    // Add an empty recipient row → invalid → Save disabled again.
    fireEvent.click(screen.getByTestId('recipient-add-dailyDigest'));
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
    expect(screen.queryByTestId('recipient-input-dailyDigest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('holiday-save')).not.toBeInTheDocument();
    expect(fetchReportRecipients).not.toHaveBeenCalled();
    expect(fetchHolidays).not.toHaveBeenCalled();
  });
});
