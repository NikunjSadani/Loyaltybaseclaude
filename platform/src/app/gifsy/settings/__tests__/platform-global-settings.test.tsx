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
 * P2b: removing a row + Save sends the shorter list; a save failure shows the backend's message
 * P2c: empty-list copy is truthful per state (saved-empty / nothing saved / unsaved removal);
 *      the retired per-report groups are gone
 * P3: Save is disabled until the data has loaded AND is valid
 * P4: adding a holiday row + Save calls saveHolidays with the row
 * P5: a non-GIFSY_ADMIN operator sees neither editable card (read-only note, no fetch)
 * R1: a failed GET shows a red load error, no editable list and no Save
 * R2: the legacy (inherited) label shows until the first successful save
 * R3: the domain rule is shown; a non-allowed row gets an inline error and disables Save
 * R4: addresses the server reports as blocked are flagged inline
 * L1–L3: the API client returns discriminated results and never swallows a failure
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
import type { ReportRecipientsState } from '@/lib/report-recipients';
import { fetchHolidays, saveHolidays } from '@/lib/holidays';
import { api } from '@/lib/api-client';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const state = (over: Partial<ReportRecipientsState> = {}): ReportRecipientsState => ({
  dailyDigest: ['finance@gifsy.in', 'ops@gifsy.in'],
  source: 'saved',
  allowedDomains: ['gifsy.in'],
  blocked: [],
  ...over,
});
const okResult = (over: Partial<ReportRecipientsState> = {}) => ({ ok: true as const, data: state(over) });

describe('Operator settings — platform-global cards', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockRole = 'GIFSY_ADMIN';
    asMock(fetchReportRecipients).mockResolvedValue(okResult());
    // Echo the saved list back as the server would.
    asMock(saveReportRecipients).mockImplementation(async (r: { dailyDigest: string[] }) =>
      okResult({ dailyDigest: r.dailyDigest, source: 'saved' }),
    );
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
      expect(inputs.map((el) => el.value)).toEqual(['finance@gifsy.in', 'ops@gifsy.in']);
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
    fireEvent.change(inputs[2], { target: { value: ' New@Gifsy.in ' } });

    await waitFor(() => expect(screen.getByTestId('recipients-save')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => {
      expect(saveReportRecipients).toHaveBeenCalledWith({
        dailyDigest: ['finance@gifsy.in', 'ops@gifsy.in', 'New@Gifsy.in'],
      });
    });
  });

  it("P2b: removing a row + Save sends the shorter list; a failed save shows the backend's message", async () => {
    asMock(saveReportRecipients).mockResolvedValue({
      ok: false,
      error: 'These addresses are not on an allowed domain: x@acme.test',
    });
    render(<GifsySettingsPage />);
    await waitFor(() => expect(screen.getAllByTestId('recipient-input-dailyDigest')).toHaveLength(2));
    fireEvent.click(screen.getByLabelText('Remove finance@gifsy.in'));
    expect(screen.getAllByTestId('recipient-input-dailyDigest')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => expect(saveReportRecipients).toHaveBeenCalledWith({ dailyDigest: ['ops@gifsy.in'] }));
    expect(
      await screen.findByText(/Could not save the report recipients — These addresses are not on an allowed domain: x@acme\.test/),
    ).toBeInTheDocument();
  });

  it('P2c: a saved empty list says nobody gets the digest; the retired per-report groups are gone', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(okResult({ dailyDigest: [], source: 'saved' }));
    render(<GifsySettingsPage />);
    expect(await screen.findByText('The saved list is empty — nobody gets the digest.')).toBeInTheDocument();
    expect(screen.queryByText(/until you do/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-group-creditsPayouts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-group-kycActionables')).not.toBeInTheDocument();
    expect(screen.queryByText('Credits & Payouts summary')).not.toBeInTheDocument();
  });

  it('P2c-2: nothing saved yet + empty list → "No recipients yet" copy', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(okResult({ dailyDigest: [], source: 'none' }));
    render(<GifsySettingsPage />);
    expect(
      await screen.findByText('No recipients yet — nobody gets the digest until you add one and save.'),
    ).toBeInTheDocument();
  });

  it('P2c-3: removing every loaded row (unsaved) warns that saving empty means nobody gets it', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(okResult({ dailyDigest: ['ops@gifsy.in'], source: 'legacy' }));
    render(<GifsySettingsPage />);
    fireEvent.click(await screen.findByLabelText('Remove ops@gifsy.in'));
    expect(
      await screen.findByText('Unsaved: saving an empty list means nobody gets the digest.'),
    ).toBeInTheDocument();
  });

  it('P3: Save is disabled until data is loaded AND valid', async () => {
    // Hold the recipients fetch unresolved so the card stays in its loading state.
    let resolveFetch!: (v: ReturnType<typeof okResult>) => void;
    asMock(fetchReportRecipients).mockReturnValue(
      new Promise((res) => { resolveFetch = res; }),
    );
    render(<GifsySettingsPage />);

    // Before the fetch resolves there is no Save button (card shows "Loading recipients…").
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();

    // Resolve → the editable card + Save appear, enabled (loaded + valid).
    resolveFetch(okResult({ dailyDigest: ['finance@gifsy.in'] }));
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

  it('R1: a failed GET shows a red load error, no editable list and no Save', async () => {
    asMock(fetchReportRecipients).mockResolvedValue({ ok: false, error: 'Internal server error' });
    render(<GifsySettingsPage />);
    const err = await screen.findByTestId('recipients-load-error');
    expect(err).toHaveTextContent(
      "Couldn't load the report recipients — Internal server error. Reload to try again; saving is disabled so the current list isn't overwritten.",
    );
    expect(err.className).toMatch(/red/);
    expect(screen.queryByTestId('recipients-group-dailyDigest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipient-input-dailyDigest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipient-add-dailyDigest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();
    expect(screen.queryByText(/nobody gets the digest/)).not.toBeInTheDocument();
  });

  it('R1b: a rejected GET (network throw) is also shown as a load error', async () => {
    asMock(fetchReportRecipients).mockRejectedValue(new Error('Network down'));
    render(<GifsySettingsPage />);
    expect(await screen.findByTestId('recipients-load-error')).toHaveTextContent(/Network down/);
    expect(screen.queryByTestId('recipients-save')).not.toBeInTheDocument();
  });

  it('R2: the legacy list is labelled inherited until the first successful save', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(okResult({ source: 'legacy' }));
    render(<GifsySettingsPage />);
    expect(await screen.findByTestId('recipients-inherited')).toHaveTextContent(
      "Inherited from the two old daily emails' lists",
    );
    fireEvent.click(screen.getByTestId('recipients-save'));
    await waitFor(() => expect(saveReportRecipients).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('recipients-inherited')).not.toBeInTheDocument());
  });

  it('R2b: a saved list shows no inherited label', async () => {
    render(<GifsySettingsPage />);
    await screen.findAllByTestId('recipient-input-dailyDigest');
    expect(screen.queryByTestId('recipients-inherited')).not.toBeInTheDocument();
  });

  it('R3: the domain rule is shown; a non-allowed row gets an inline error and disables Save', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(okResult({ allowedDomains: ['gifsy.in', 'gifsy.com'] }));
    render(<GifsySettingsPage />);
    expect(await screen.findByTestId('recipients-domain-rule')).toHaveTextContent(
      'Internal Gifsy addresses only: @gifsy.in, @gifsy.com',
    );
    await waitFor(() => expect(screen.getByTestId('recipients-save')).not.toBeDisabled());
    expect(screen.queryByTestId('recipient-error-dailyDigest')).not.toBeInTheDocument();

    const inputs = screen.getAllByTestId('recipient-input-dailyDigest') as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: 'someone@acme.test' } });
    const rowErr = await screen.findByTestId('recipient-error-dailyDigest');
    expect(rowErr).toHaveTextContent('Not an internal address — only @gifsy.in, @gifsy.com is allowed');
    await waitFor(() => expect(screen.getByTestId('recipients-save')).toBeDisabled());

    // A look-alike subdomain is not the exact allowed domain; uppercase of an allowed one is fine.
    fireEvent.change(inputs[1], { target: { value: 'a@evil-gifsy.in' } });
    expect(await screen.findByTestId('recipient-error-dailyDigest')).toBeInTheDocument();
    fireEvent.change(inputs[1], { target: { value: 'A@GIFSY.COM' } });
    await waitFor(() => expect(screen.queryByTestId('recipient-error-dailyDigest')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('recipients-save')).not.toBeDisabled());
  });

  it('R4: addresses the server reports as blocked are flagged inline and block Save', async () => {
    asMock(fetchReportRecipients).mockResolvedValue(
      okResult({ dailyDigest: ['ops@gifsy.in', 'client@acme.test'], source: 'legacy', blocked: ['client@acme.test'] }),
    );
    render(<GifsySettingsPage />);
    const errs = await screen.findAllByTestId('recipient-error-dailyDigest');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toHaveTextContent('Not an internal address — only @gifsy.in is allowed');
    await waitFor(() => expect(screen.getByTestId('recipients-save')).toBeDisabled());
    fireEvent.click(screen.getByLabelText('Remove client@acme.test'));
    await waitFor(() => expect(screen.queryByTestId('recipient-error-dailyDigest')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('recipients-save')).not.toBeDisabled());
  });
});

describe('report-recipients API client', () => {
  type Lib = typeof import('@/lib/report-recipients');
  let lib: Lib;
  beforeEach(async () => {
    vi.clearAllMocks();
    lib = await vi.importActual<Lib>('@/lib/report-recipients');
  });

  it('L1: a failed GET is returned as { ok: false, error } — never an empty list', async () => {
    asMock(api.get).mockResolvedValueOnce({ success: false, error: 'Forbidden', status: 403 });
    expect(await lib.fetchReportRecipients()).toEqual({ ok: false, error: 'Forbidden' });
    asMock(api.get).mockResolvedValueOnce({ success: true, data: {} });
    const malformed = await lib.fetchReportRecipients();
    expect(malformed.ok).toBe(false);
  });

  it('L2: a GET defaults missing optional fields', async () => {
    asMock(api.get).mockResolvedValueOnce({ success: true, data: { recipients: { dailyDigest: ['a@gifsy.in'] } } });
    expect(await lib.fetchReportRecipients()).toEqual({
      ok: true,
      data: { dailyDigest: ['a@gifsy.in'], source: 'none', allowedDomains: ['gifsy.in'], blocked: [] },
    });
    asMock(api.get).mockResolvedValueOnce({
      success: true,
      data: { recipients: { dailyDigest: ['x@acme.test'] }, source: 'legacy', allowedDomains: ['gifsy.in'], blocked: ['x@acme.test'] },
    });
    expect(await lib.fetchReportRecipients()).toEqual({
      ok: true,
      data: { dailyDigest: ['x@acme.test'], source: 'legacy', allowedDomains: ['gifsy.in'], blocked: ['x@acme.test'] },
    });
  });

  it("L3: a failed PUT surfaces the backend's message; a success returns the server state", async () => {
    asMock(api.put).mockResolvedValueOnce({ success: false, error: 'Not allowed: x@acme.test', status: 400 });
    expect(await lib.saveReportRecipients({ dailyDigest: ['x@acme.test'] })).toEqual({
      ok: false,
      error: 'Not allowed: x@acme.test',
    });
    asMock(api.put).mockResolvedValueOnce({
      success: true,
      data: { recipients: { dailyDigest: ['a@gifsy.in'] }, source: 'saved', allowedDomains: ['gifsy.in'], blocked: [] },
    });
    expect(await lib.saveReportRecipients({ dailyDigest: ['a@gifsy.in'] })).toEqual({
      ok: true,
      data: { dailyDigest: ['a@gifsy.in'], source: 'saved', allowedDomains: ['gifsy.in'], blocked: [] },
    });
    expect(api.put).toHaveBeenLastCalledWith('/api/admin/settings/report-recipients', { dailyDigest: ['a@gifsy.in'] });
  });
});
