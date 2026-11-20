/**
 * Reports hub — "Redemption report" card: default IST month range (cleared dates snap back), live summary (points
 * DEDUCTED), loading on every reload, filters → export URL, Download disabled with a reason (no client / 0 orders /
 * error / bad range), hidden for MIS users, honest description (the client's own ASM-level label).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));
const session = vi.hoisted(() => ({ role: 'CLIENT_ADMIN' }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role, name: '', userId: '', canManageSchemes: false }) }));

import ReportsPage from '../page';
import { RedemptionReportCard, istMonthToDate } from '../redemption-report-card';

const fetchMock = vi.fn();
const SUMMARY = {
  orders: 1234,
  pointsDeducted: 56000,
  valueInr: 5600.5,
  pointsRequested: 60000,
  preparedInBackground: false,
  zones: ['East', 'West'],
  states: ['Maharashtra'],
  asmLevelLabel: 'ASM',
};
let summary: Record<string, unknown> = SUMMARY;

function respond(url: string) {
  if (url.startsWith('/api/reports/redemptions/export')) {
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'attachment; filename="redemption-report-bajaj.xlsx"' },
      blob: () => Promise.resolve(new Blob(['x'])),
    });
  }
  if (url.startsWith('/api/reports/redemptions')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: summary }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

const button = () => screen.getByRole('button', { name: /download redemption report/i });

beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  summary = SUMMARY;
  session.role = 'CLIENT_ADMIN';
  fetchMock.mockImplementation((u: string) => respond(String(u)));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Redemption report card', () => {
  it('is listed on the Reports hub for admins and hidden for MIS users', async () => {
    const { unmount } = render(<ReportsPage />);
    expect(await screen.findByTestId('redemption-report-card')).toBeInTheDocument();
    unmount();
    session.role = 'MIS_USER';
    render(<ReportsPage />);
    expect(screen.queryByTestId('redemption-report-card')).not.toBeInTheDocument();
  });

  it('hides itself if the API refuses the role (403)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    render(<RedemptionReportCard />);
    await waitFor(() => expect(screen.queryByTestId('redemption-report-card')).not.toBeInTheDocument());
  });

  it('defaults to this IST month, shows points DEDUCTED + the ASM-level description', async () => {
    render(<RedemptionReportCard />);
    const { from, to } = istMonthToDate();
    expect(screen.getByLabelText('Redeemed from')).toHaveValue(from);
    expect(screen.getByLabelText('Redeemed to')).toHaveAttribute('max', to);
    const s = screen.getByTestId('redemption-summary');
    await waitFor(() => expect(s).toHaveTextContent('1,234 orders · 56,000 points deducted'));
    expect(s).toHaveTextContent('60,000 points requested');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/reports/redemptions?from=${from}&to=${to}`);
    expect(within(screen.getByLabelText('Zone')).getByRole('option', { name: 'West' })).toBeInTheDocument();
    expect(screen.getByTestId('redemption-description')).toHaveTextContent('summary by zone, state, ASM, reward, status');
    expect(button()).toBeEnabled();
  });

  it('a client without an ASM level gets no "ASM" promise in the description', async () => {
    summary = { ...SUMMARY, asmLevelLabel: null };
    render(<RedemptionReportCard />);
    await screen.findByText(/1,234/);
    expect(screen.getByTestId('redemption-description')).toHaveTextContent('summary by zone, state, reward, status.');
  });

  it('shows "Counting orders…" again on every reload', async () => {
    render(<RedemptionReportCard />);
    await screen.findByText(/1,234/);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DELIVERED' } });
    expect(screen.getByTestId('redemption-summary')).toHaveTextContent('Counting orders…');
    expect(button()).toBeDisabled();
    await screen.findByText(/1,234/);
  });

  it('a cleared date snaps back to the default it will use', async () => {
    render(<RedemptionReportCard />);
    const { from, to } = istMonthToDate();
    fireEvent.change(screen.getByLabelText('Redeemed from'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Redeemed to'), { target: { value: '' } });
    expect(screen.getByLabelText('Redeemed from')).toHaveValue(from);
    expect(screen.getByLabelText('Redeemed to')).toHaveValue(to);
  });

  it('downloads with every chosen filter in the URL', async () => {
    render(<RedemptionReportCard />);
    await screen.findByText(/1,234/);
    fireEvent.change(screen.getByLabelText('Redeemed from'), { target: { value: '2025-10-01' } });
    fireEvent.change(screen.getByLabelText('Redeemed to'), { target: { value: '2025-10-31' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DELIVERED' } });
    fireEvent.change(screen.getByLabelText('Reward type'), { target: { value: 'CASH' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'West' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Maharashtra' } });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const exportUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/export'));
    expect(exportUrl).toBe('/api/reports/redemptions/export?from=2025-10-01&to=2025-10-31&status=DELIVERED&rewardType=CASH&zone=West&state=Maharashtra');
    expect(downloadBlob.mock.calls[0][1]).toBe('redemption-report-bajaj.xlsx');
  });

  it('an un-assumed Gifsy admin sees "Choose a client" and cannot download', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ success: false, error: 'Choose a client (assume one) to download — this report lists one client at a time.' }) }),
    );
    render(<RedemptionReportCard />);
    expect(await screen.findByTestId('redemption-blocked')).toHaveTextContent('Choose a client (assume one) to download');
    expect(button()).toBeDisabled();
  });

  it('0 orders → Download disabled with the reason', async () => {
    summary = { ...SUMMARY, orders: 0, pointsDeducted: 0, pointsRequested: 0, valueInr: 0 };
    render(<RedemptionReportCard />);
    expect(await screen.findByTestId('redemption-blocked')).toHaveTextContent('No redemptions match these filters');
    expect(button()).toBeDisabled();
  });

  it('blocks a From date after the To date', async () => {
    render(<RedemptionReportCard />);
    fireEvent.change(screen.getByLabelText('Redeemed from'), { target: { value: '2025-11-30' } });
    fireEvent.change(screen.getByLabelText('Redeemed to'), { target: { value: '2025-11-01' } });
    expect(await screen.findByTestId('redemption-blocked')).toHaveTextContent('on or before');
    expect(button()).toBeDisabled();
  });

  it('istMonthToDate uses the IST day (00:30 IST on the 1st is the new month)', () => {
    expect(istMonthToDate(new Date(Date.UTC(2025, 9, 31, 19, 0)))).toEqual({ from: '2025-11-01', to: '2025-11-01' });
  });
});
