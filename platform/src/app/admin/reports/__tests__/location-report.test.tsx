/**
 * Location Report page (/admin/reports/location — LOCATION-GATE.md): load → setting state + totals + rows; filters
 * re-query with the right params; error + retry; empty state; Excel export (404 "0 reps matched" → neutral note);
 * the reports index links to it. Plus the pure helpers in lib/location-report.ts.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import LocationPage from '../location/page';
import ReportsPage from '../page';
import { fmtLockSeconds, locationQuery, type LocationReportPage } from '@/lib/location-report';

const fetchMock = vi.fn();

function report(over: Partial<LocationReportPage> = {}): LocationReportPage {
  return {
    generatedAt: '2026-11-20T06:30:00.000Z',
    range: { from: '2026-10-22', to: '2026-11-20', days: 30 },
    setting: { requireLocation: true, fenceOn: true, outletMasterFence: true },
    notes: { sources: 'S.', accuracy: 'A.', unverifiable: 'U.', blocked: 'B.', lock: 'L.', region: 'R.' },
    filters: { roles: ['SALES_ISR', 'SALES_SO'], regions: ['Gujarat', 'West'] },
    totals: {
      reps: 2, kycs: 5, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3,
      medianAccuracyM: 12, medianLockMs: 1500,
    },
    page: 1, pageSize: 50, pageCount: 1, totalRows: 1,
    rows: [{
      userId: 'isr1', name: 'Asha ISR', phone: '9876500001', role: 'SALES_ISR', regions: ['Maharashtra'],
      kycs: 4, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3,
      medianAccuracyM: 15, medianLockMs: 2100,
    }],
    ...over,
  };
}

const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });
const jsonCalls = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/reports/location-compliance') && !u.includes('format=xlsx'));

beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lib/location-report helpers', () => {
  it('builds only the chosen filters; formats lock seconds', () => {
    expect(locationQuery({ from: '2026-11-01', to: '2026-11-30', role: '', region: '', sort: 'issues' })).toBe('from=2026-11-01&to=2026-11-30');
    expect(locationQuery({ from: 'a', to: 'b', role: 'SALES_ISR', region: 'West', sort: 'name' }, { format: 'xlsx' }))
      .toBe('from=a&to=b&role=SALES_ISR&region=West&sort=name&format=xlsx');
    expect(fmtLockSeconds(2100)).toBe('2.1 s');
    expect(fmtLockSeconds(null)).toBe('—');
  });
});

describe('Location Report page', () => {
  it('loads → setting note, totals, rows', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<LocationPage />);
    expect(await screen.findByText('Asha ISR')).toBeTruthy();
    expect(screen.getByTestId('location-setting').textContent).toMatch(/Require location is ON/);
    const totals = screen.getByTestId('location-totals');
    expect(within(totals).getByText('11')).toBeTruthy(); // 5 KYCs + 6 visibility
    expect(within(totals).getByText('±12 m')).toBeTruthy();
    expect(within(totals).getByText('KYC lock 1.5 s')).toBeTruthy();
    const row = screen.getByText('Asha ISR').closest('tr')!;
    expect(within(row).getByText('2.1 s')).toBeTruthy();
    expect(jsonCalls()[0]).toMatch(/page=1&pageSize=50/);
  });

  it('a role / region change re-queries with that filter', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<LocationPage />);
    await screen.findByText('Asha ISR');
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'West' } });
    await waitFor(() => expect(jsonCalls().some((u) => u.includes('region=West'))).toBe(true), { timeout: 3000 });
  });

  it('setting OFF is said plainly; empty state when no rep had activity', async () => {
    fetchMock.mockResolvedValue(ok(report({ setting: { requireLocation: false, fenceOn: false, outletMasterFence: false }, rows: [], totalRows: 0 })));
    render(<LocationPage />);
    expect(await screen.findByText(/No KYCs, visibility captures or blocked attempts/)).toBeTruthy();
    expect(screen.getByTestId('location-setting').textContent).toMatch(/Require location is OFF/);
  });

  it('error → message + Retry', async () => {
    fetchMock.mockResolvedValueOnce(fail(503, 'The location report took too long to build.'));
    render(<LocationPage />);
    expect(await screen.findByText('The location report took too long to build.')).toBeTruthy();
    fetchMock.mockResolvedValue(ok(report()));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Asha ISR')).toBeTruthy();
  });

  it('Export Excel: 404 "0 reps matched" → neutral note, nothing saved', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('format=xlsx') ? fail(404, '0 reps matched these filters.') : ok(report())),
    );
    render(<LocationPage />);
    await screen.findByText('Asha ISR');
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    expect(await screen.findByText(/0 reps matched these filters — nothing to download/)).toBeTruthy();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('Reports index', () => {
  it('lists the Location Report with an Open report link to /admin/reports/location', () => {
    render(<ReportsPage />);
    let el: HTMLElement | null = screen.getByText('Location Report');
    while (el && !el.querySelector('a[href="/admin/reports/location"]')) el = el.parentElement;
    expect(el).toBeTruthy();
  });
});
