/**
 * Reports hub — "Redemption report" card: default IST month range, live summary, filters → export URL, server errors
 * shown plainly, invalid range blocked.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import ReportsPage from '../page';
import { RedemptionReportCard, istMonthToDate } from '../redemption-report-card';

const fetchMock = vi.fn();
const SUMMARY = { orders: 1234, points: 56000, valueInr: 5600.5, preparedInBackground: false, zones: ['East', 'West'], states: ['Maharashtra'] };

function respond(url: string) {
  if (url.startsWith('/api/reports/redemptions/export')) {
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'attachment; filename="redemption-report-bajaj.xlsx"' },
      blob: () => Promise.resolve(new Blob(['x'])),
    });
  }
  if (url.startsWith('/api/reports/redemptions')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: SUMMARY }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  fetchMock.mockImplementation((u: string) => respond(String(u)));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Redemption report card', () => {
  it('is listed on the Reports hub', async () => {
    render(<ReportsPage />);
    expect(await screen.findByTestId('redemption-report-card')).toBeInTheDocument();
  });

  it('defaults to this IST month and shows the live summary + zone/state options', async () => {
    render(<RedemptionReportCard />);
    const { from, to } = istMonthToDate();
    expect(screen.getByLabelText('Redeemed from')).toHaveValue(from);
    expect(screen.getByLabelText('Redeemed to')).toHaveValue(to);
    const summary = await screen.findByTestId('redemption-summary');
    await waitFor(() => expect(summary).toHaveTextContent('1,234 orders'));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/reports/redemptions?from=${from}&to=${to}`);
    expect(within(screen.getByLabelText('Zone')).getByRole('option', { name: 'West' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /download redemption report/i }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const exportUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/export'));
    expect(exportUrl).toBe('/api/reports/redemptions/export?from=2025-10-01&to=2025-10-31&status=DELIVERED&rewardType=CASH&zone=West&state=Maharashtra');
    expect(downloadBlob.mock.calls[0][1]).toBe('redemption-report-bajaj.xlsx');
  });

  it('shows the server message when the summary is refused (e.g. Gifsy owner with no client chosen)', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ success: false, error: 'Choose a client first' }) }),
    );
    render(<RedemptionReportCard />);
    expect(await screen.findByText('Choose a client first')).toBeInTheDocument();
  });

  it('blocks a From date after the To date', async () => {
    render(<RedemptionReportCard />);
    fireEvent.change(screen.getByLabelText('Redeemed from'), { target: { value: '2025-11-30' } });
    fireEvent.change(screen.getByLabelText('Redeemed to'), { target: { value: '2025-11-01' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('on or before');
    expect(screen.getByRole('button', { name: /download redemption report/i })).toBeDisabled();
  });

  it('istMonthToDate uses the IST day (00:30 IST on the 1st is the new month)', () => {
    expect(istMonthToDate(new Date(Date.UTC(2025, 9, 31, 19, 0)))).toEqual({ from: '2025-11-01', to: '2025-11-01' });
  });
});
