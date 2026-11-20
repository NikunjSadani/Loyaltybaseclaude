/**
 * Usage Report page (/admin/reports/usage): load → totals + rows + honest duration note; filters / toggle /
 * sort / pagination re-query with the right params; invalid range never queries; error + retry; empty states;
 * a stale (slower) response never overwrites a newer one; Excel export of the same filters (200 saves, 404 "0 users
 * matched" → neutral note). Plus the pure helpers in lib/usage-report.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import UsagePage from '../usage/page';
import ReportsPage from '../page';
import { defaultIstRange, rangeProblem, usageQuery, type UsageReportPage } from '@/lib/usage-report';

const fetchMock = vi.fn();

function row(over: Partial<UsageReportPage['rows'][number]> = {}): UsageReportPage['rows'][number] {
  return {
    userId: 'u1', name: 'Asha Retail', phone: '9876500001', role: 'SSS', status: 'ACTIVE',
    programmes: ['Gold'], regions: ['Maharashtra'], asm: ['Priya Mehta'], zone: ['West'], state: ['Maharashtra'], city: ['Pune'], daysActive: 5, trackedDays: 4, visits: 7, minutes: 50,
    avgMinutesPerDay: 12.5, appDays: 4, browserDays: 0, phoneDays: 4, computerDays: 0, device: 'Phone',
    firstSeenAt: '2026-11-10T04:00:00.000Z', lastSeenAt: '2026-11-19T10:00:00.000Z', ...over,
  };
}

function report(over: Partial<UsageReportPage> = {}): UsageReportPage {
  return {
    generatedAt: '2026-11-20T06:30:00.000Z',
    range: { from: '2026-10-22', to: '2026-11-20', days: 30 },
    trackingStartedOn: '2026-11-18',
    notes: { duration: 'x', region: 'Programme and region come from outlets: a retailer’s own outlets.' },
    filters: { roles: ['CLIENT_ADMIN', 'SALES_SO', 'SSS'], programs: ['Gold', 'Silver'], regions: ['Gujarat', 'Maharashtra'] },
    totals: {
      usersInScope: 7, usersActive: 4, usersInactive: 3, disabledAccountsExcluded: 2, avgDaysActive: 4.8, totalMinutes: 72,
      usersTracked: 3, avgMinutesPerTrackedUser: 24, appUsers: 2, browserUsers: 2, phoneUsers: 3, computerUsers: 1,
    },
    page: 1, pageSize: 50, pageCount: 1, totalRows: 1, rows: [row()],
    ...over,
  };
}

const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });
const jsonCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/reports/usage') && !u.includes('format=xlsx'));
const lastParams = () => new URLSearchParams(jsonCalls().at(-1)!.split('?')[1]);

beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lib/usage-report helpers', () => {
  it('defaultIstRange: last 30 IST days ending today (IST rolls at 18:30Z)', () => {
    expect(defaultIstRange(new Date('2026-11-20T06:30:00Z'))).toEqual({ from: '2026-10-22', to: '2026-11-20' });
    expect(defaultIstRange(new Date('2026-11-20T18:31:00Z')).to).toBe('2026-11-21');
  });
  it('rangeProblem: from > to, > 366 days, missing', () => {
    expect(rangeProblem('2026-11-01', '2026-11-30')).toBeNull();
    expect(rangeProblem('2025-11-20', '2026-11-20')).toBeNull(); // 366 days
    expect(rangeProblem('2025-11-19', '2026-11-20')).toMatch(/at most 366/);
    expect(rangeProblem('2026-12-01', '2026-11-30')).toMatch(/on or before/);
    expect(rangeProblem('', '2026-11-30')).toMatch(/both/);
  });
  it('usageQuery: only chosen filters', () => {
    const base = { from: '2026-11-01', to: '2026-11-30', role: '', program: '', region: '', sort: 'minutes' as const, includeInactive: false };
    expect(usageQuery(base)).toBe('from=2026-11-01&to=2026-11-30');
    expect(usageQuery({ ...base, role: 'SSS', program: 'Gold', region: 'Goa', sort: 'days', includeInactive: true }, { format: 'xlsx' }))
      .toBe('from=2026-11-01&to=2026-11-30&role=SSS&program=Gold&region=Goa&sort=days&includeInactive=true&format=xlsx');
  });
});

describe('Usage Report page', () => {
  it('loads the default range and shows totals, rows and the honest duration note with the tracking start date', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<UsagePage />);
    expect(screen.getByTestId('usage-loading')).toBeTruthy();
    await screen.findByText('Asha Retail');
    const p = lastParams();
    expect(p.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.get('pageSize')).toBe('50');
    expect(p.get('page')).toBe('1');
    expect(p.has('includeInactive')).toBe(false);

    const note = screen.getByTestId('usage-note');
    expect(note.textContent).toMatch(/first and last action in each visit/);
    expect(note.textContent).toMatch(/30 minutes idle/);
    expect(note.textContent).toMatch(/minimum/);
    expect(note.textContent).toMatch(/Tracking started on 18 Nov 2026/);
    expect(note.textContent).toMatch(/retailer’s own outlets/);

    const totals = screen.getByTestId('usage-totals');
    expect(within(totals).getByText('4 of 7')).toBeTruthy();
    expect(within(totals).getByText('72')).toBeTruthy();
    expect(within(totals).getByText('3 did not use it · 2 deactivated/suspended not counted')).toBeTruthy();
    expect(within(totals).getByText('avg 24 per user with tracked days (3)')).toBeTruthy();
    expect(note.textContent).toMatch(/Automatic refreshes .* are not counted/);
    expect(screen.getByText(/Usage per user, 2026-10-22 to 2026-11-20/)).toBeTruthy(); // table caption
    const tr = screen.getByText('Asha Retail').closest('tr')!;
    expect(within(tr).getByText('Gold')).toBeTruthy();
    expect(within(tr).getByText('Phone')).toBeTruthy();
    expect(within(tr).getByText('12.5')).toBeTruthy();
  });

  it('area columns sit right after Role (tenant ASM header), above-ASM is labelled, and the notes explain them', async () => {
    fetchMock.mockResolvedValue(ok(report({
      asmHeader: 'Area Manager',
      notes: { duration: 'x', region: 'r', area: ['ASM line: the manager this user reports to.', 'Geo line.', 'Not set line.'] },
      rows: [row(), row({ userId: 'u2', name: 'Zed ZH', role: 'SALES_STATE_HEAD', asm: ['Above Area Manager level'], zone: ['North'], state: ['Delhi'], city: ['Not set'] })],
      totalRows: 2,
    })));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 7)).toEqual(['User', 'Role', 'Area Manager', 'Zone', 'State', 'City', 'Mobile']);
    const cells = within(screen.getByText('Asha Retail').closest('tr')!).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(0, 6)).toEqual(['Asha Retail', 'SSS', 'Priya Mehta', 'West', 'Maharashtra', 'Pune']);
    const zh = within(screen.getByText('Zed ZH').closest('tr')!).getAllByRole('cell').map((c) => c.textContent);
    expect(zh.slice(2, 6)).toEqual(['Above Area Manager level', 'North', 'Delhi', 'Not set']);
    expect(screen.getAllByTestId('usage-area-note').map((n) => n.textContent)).toEqual([
      'ASM line: the manager this user reports to.', 'Geo line.', 'Not set line.',
    ]);
  });

  it('a long area list is capped at 5 with "+N more"; the full list is in the tooltip and expands on click', async () => {
    const cities = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    fetchMock.mockResolvedValue(ok(report({ rows: [row({ city: cities })] })));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    const cell = within(screen.getByText('Asha Retail').closest('tr')!).getAllByRole('cell')[5];
    expect(cell.getAttribute('title')).toBe('A, B, C, D, E, F, G');
    expect(cell.textContent).toBe('A, B, C, D, E+2 more');
    fireEvent.click(within(cell).getByRole('button', { name: '+2 more' }));
    expect(cell.textContent).toBe('A, B, C, D, E, F, Gshow less');
    expect(within(cell).getByRole('button', { name: 'show less' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('no tracked data yet → says so instead of a date', async () => {
    fetchMock.mockResolvedValue(ok(report({ trackingStartedOn: null })));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    expect(screen.getByTestId('usage-note').textContent).toMatch(/has not recorded any activity/);
  });

  it('role / programme / region / sort / inactive toggle re-query with those params (page reset to 1)', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SSS' } });
    await waitFor(() => expect(lastParams().get('role')).toBe('SSS'));
    fireEvent.change(screen.getByLabelText('Programme'), { target: { value: 'Gold' } });
    await waitFor(() => expect(lastParams().get('program')).toBe('Gold'));
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'Gujarat' } });
    await waitFor(() => expect(lastParams().get('region')).toBe('Gujarat'));
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'lastSeen' } });
    await waitFor(() => expect(lastParams().get('sort')).toBe('lastSeen'));
    fireEvent.click(screen.getByLabelText(/Show users with no activity in this range/));
    await waitFor(() => expect(lastParams().get('includeInactive')).toBe('true'));
    expect(lastParams().get('page')).toBe('1');
  });

  it('M5: totals are dimmed (aria-busy) while new filters load', async () => {
    fetchMock.mockResolvedValueOnce(ok(report()));
    let release!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    expect(screen.getByTestId('usage-totals').getAttribute('aria-busy')).toBe('false');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SSS' } });
    await waitFor(() => expect(screen.getByTestId('usage-totals').getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByTestId('usage-totals').className).toMatch(/opacity-40/); // dimmed already during the debounce
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    release(ok(report()));
    await waitFor(() => expect(screen.getByTestId('usage-totals').getAttribute('aria-busy')).toBe('false'));
  });

  it('a 503 "not available yet" (migration not applied) is shown as a plain message, with Retry', async () => {
    fetchMock.mockResolvedValue(fail(503, 'The usage report is not available yet: its database update has not been applied on this server. Please contact Gifsy.'));
    render(<UsagePage />);
    expect(await screen.findByText(/not available yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('debounces a burst of filter changes into ONE request carrying all of them', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    const before = jsonCalls().length;
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SSS' } });
    fireEvent.change(screen.getByLabelText('Programme'), { target: { value: 'Gold' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'Gujarat' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(jsonCalls().length).toBe(before); // still waiting (debounce)
    await waitFor(() => expect(jsonCalls().length).toBe(before + 1));
    const q = lastParams();
    expect([q.get('role'), q.get('program'), q.get('region')]).toEqual(['SSS', 'Gold', 'Gujarat']);
    await new Promise((r) => setTimeout(r, 500));
    expect(jsonCalls().length).toBe(before + 1);
  });

  it('a superseded request is aborted (AbortController)', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return signals.length === 1 ? new Promise(() => undefined) : Promise.resolve(ok(report()));
    });
    render(<UsagePage />);
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await screen.findByText('Asha Retail');
  });

  it('pagination: Next asks for page 2', async () => {
    fetchMock.mockResolvedValue(ok(report({ pageCount: 3, totalRows: 120 })));
    render(<UsagePage />);
    await screen.findByText('Page 1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams().get('page')).toBe('2'));
  });

  it('an invalid range shows a plain message and never queries', async () => {
    fetchMock.mockResolvedValue(ok(report()));
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    const before = jsonCalls().length;
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2099-01-01' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/on or before/);
    expect(jsonCalls().length).toBe(before);
  });

  it('server error → message + Retry re-queries', async () => {
    fetchMock.mockResolvedValueOnce(fail(400, 'The date range can be at most 366 days'));
    render(<UsagePage />);
    expect(await screen.findByText('The date range can be at most 366 days')).toBeTruthy();
    fetchMock.mockResolvedValue(ok(report()));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Asha Retail');
  });

  it('empty: active-only hints at the toggle; with inactive shown says no users match', async () => {
    fetchMock.mockResolvedValue(ok(report({ rows: [], totalRows: 0 })));
    render(<UsagePage />);
    expect(await screen.findByText(/No one used the app in this range/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /export excel/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Show users with no activity in this range/));
    expect(await screen.findByText('No users match these filters.')).toBeTruthy();
  });

  it('a slower, OLDER response never overwrites the newer one', async () => {
    let resolveOld!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    fetchMock.mockResolvedValue(ok(report({ rows: [row({ userId: 'new', name: 'Newest Answer' })] })));
    render(<UsagePage />);
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    await screen.findByText('Newest Answer');
    resolveOld(ok(report({ rows: [row({ userId: 'old', name: 'Stale Answer' })] })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Stale Answer')).toBeNull();
    expect(screen.getByText('Newest Answer')).toBeTruthy();
  });

  it('Export Excel sends the SAME filters with format=xlsx (no page) and saves the file', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('format=xlsx')
          ? { ok: true, status: 200, headers: { get: () => 'attachment; filename="usage-report-x.xlsx"' }, blob: () => Promise.resolve(new Blob(['x'])) }
          : ok(report()),
      ),
    );
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SSS' } });
    await waitFor(() => expect(lastParams().get('role')).toBe('SSS'));
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const xUrl = String(fetchMock.mock.calls.find((c) => String(c[0]).includes('format=xlsx'))![0]);
    const q = new URLSearchParams(xUrl.split('?')[1]);
    expect(q.get('role')).toBe('SSS');
    expect(q.has('page')).toBe(false);
    expect(downloadBlob.mock.calls[0][1]).toBe('usage-report-x.xlsx');
  });

  it('Export Excel → 404 "0 users matched" is a neutral note, not an error', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('format=xlsx') ? fail(404, '0 users matched these filters.') : ok(report())),
    );
    render(<UsagePage />);
    await screen.findByText('Asha Retail');
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    expect(await screen.findByText(/0 users matched these filters — nothing to download/)).toBeTruthy();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('Reports index', () => {
  it('lists the Usage Report with an Open report link to /admin/reports/usage', () => {
    // The index probes whether the Location report is enabled (LOCATION-GATE.md).
    fetchMock.mockResolvedValue(ok({ enabled: false }));
    render(<ReportsPage />);
    const title = screen.getByText('Usage Report');
    let el: HTMLElement | null = title;
    while (el && !el.querySelector('a[href="/admin/reports/usage"]')) el = el.parentElement;
    expect(el).toBeTruthy();
  });
});
