/**
 * Report download buttons (DOWNLOADS-PAGE.md): 200 saves the file, 202 shows "we're preparing your
 * file" + a Downloads link. Target-vs-Sales: on-screen preview capped at 3 months; longer → Download.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import ReportsPage from '../page';
import TargetVsSalesPage from '../target-vs-sales/page';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function card(name: string): HTMLElement {
  const title = screen.getByText(name);
  let el: HTMLElement | null = title;
  while (el && !within(el).queryByRole('button', { name: /export excel/i })) el = el.parentElement;
  if (!el) throw new Error(`card ${name} not found`);
  return el;
}

describe('Reports page — Export Excel', () => {
  it('200 → saves the file (server file name), no queued note', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => 'attachment; filename="outlet-master.xlsx"' },
      blob: () => Promise.resolve(new Blob(['x'])),
    });
    render(<ReportsPage />);
    fireEvent.click(within(card('Outlet Master')).getByRole('button', { name: /export excel/i }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob.mock.calls[0][1]).toBe('outlet-master.xlsx');
    // (the index also probes the Location report on load — LOCATION-GATE.md — so find the export call itself)
    expect(fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('format=xlsx'))).toMatch(/^\/api\/admin\/reports\/outlet-master\?format=xlsx/);
    expect(screen.queryByTestId('download-queued')).not.toBeInTheDocument();
  });

  it('202 → "preparing your file" + Downloads link, nothing saved', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 202,
      json: () => Promise.resolve({ success: true, data: { exportRequestId: 'e1', message: "We're preparing your file — it will appear under Downloads (usually 1–5 minutes)." } }),
    });
    render(<ReportsPage />);
    const c = card('KYC Status Report');
    fireEvent.click(within(c).getByRole('button', { name: /export excel/i }));
    const note = await within(c).findByTestId('download-queued');
    expect(note).toHaveTextContent(/preparing your file/i);
    expect(await within(note).findByRole('link', { name: /open downloads/i })).toHaveAttribute('href', '/admin/downloads');
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('409 → the plain server message', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409,
      json: () => Promise.resolve({ success: false, error: 'You already have 3 downloads being prepared.' }),
    });
    render(<ReportsPage />);
    const c = card('Visibility Status Report');
    fireEvent.click(within(c).getByRole('button', { name: /export excel/i }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('You already have 3 downloads being prepared.');
  });
});

describe('Target vs Sales — preview limit', () => {
  it('defaults to a 3-month range with Preview enabled', () => {
    render(<TargetVsSalesPage />);
    expect(screen.getByRole('button', { name: /generate preview/i })).toBeEnabled();
    expect(screen.queryByTestId('tvs-preview-limit')).not.toBeInTheDocument();
  });

  it('a range over 3 months disables Preview, explains why, and Download queues it', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 202,
      json: () => Promise.resolve({ success: true, data: { exportRequestId: 'e2', message: "We're preparing your file — it will appear under Downloads (usually 1–5 minutes)." } }),
    });
    const { container } = render(<TargetVsSalesPage />);
    const [fromInput, toInput] = Array.from(container.querySelectorAll('input[type="month"]')) as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: '2026-01' } });
    fireEvent.change(toInput, { target: { value: '2026-06' } });

    expect(screen.getByRole('button', { name: /generate preview/i })).toBeDisabled();
    expect(screen.getByTestId('tvs-preview-limit')).toHaveTextContent(/up to 3 months/i);

    const download = screen.getByRole('button', { name: /download excel/i });
    expect(download).toBeEnabled();
    fireEvent.click(download);
    expect(await screen.findByTestId('download-queued')).toHaveTextContent(/preparing your file/i);
    const xlsxCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('format=xlsx'));
    expect(xlsxCalls).toEqual(['/api/admin/reports/target-vs-sales?fromMonth=2026-01&toMonth=2026-06&format=xlsx']);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('Target vs Sales — filters (2026-11-23)', () => {
  const OPTIONS = {
    programs: ['Gold', 'Silver'],
    outletTypes: ['RETAIL'],
    managers: [{ id: 'm1', name: 'Asha', levelCode: 'ASM', levelName: 'ASM' }],
    buckets: [{ key: 'P0_20', label: 'Under 20%' }, { key: 'ACHIEVED', label: 'Achieved (100%+)' }],
  };

  function route(previewBody: unknown) {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/admin/reports/target-vs-sales/filters')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: OPTIONS }) };
      }
      if (u.includes('format=json')) return { ok: true, status: 200, json: async () => ({ success: true, data: previewBody }) };
      return { ok: true, status: 202, json: async () => ({ success: true, data: { exportRequestId: 'e3', message: 'Queued.' } }) };
    });
  }

  it('the chosen filters go to BOTH the preview and the Excel; columns come from the server', async () => {
    route({
      fromMonth: '2026-01', toMonth: '2026-01', months: ['2026-01'], kpis: [{ code: 'V', label: 'Volume' }],
      columns: ['Outlet Code', 'Outlet Name', 'Outlet Type', 'Programme', 'ASM Name', 'Month', 'Billing bucket', 'Volume Target'],
      rows: [{ 'Outlet Code': 'A1', 'Outlet Name': 'Shop', 'Outlet Type': 'RETAIL', Programme: 'Gold', 'ASM Name': 'Asha', Month: '2026-01', 'Billing bucket': 'Under 20%', 'Volume Target': 10 }],
      filtersSummary: 'Jan 2026 · Programme: Gold · Billing bucket: Under 20%',
    });
    const { container } = render(<TargetVsSalesPage />);
    const [fromInput, toInput] = Array.from(container.querySelectorAll('input[type="month"]')) as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: '2026-01' } });
    fireEvent.change(toInput, { target: { value: '2026-01' } });
    await screen.findByRole('option', { name: 'Gold' });
    fireEvent.change(screen.getByTestId('tvs-filter-program'), { target: { value: 'Gold' } });
    fireEvent.change(screen.getByTestId('tvs-filter-manager'), { target: { value: 'm1' } });
    fireEvent.change(screen.getByTestId('tvs-filter-bucket'), { target: { value: 'P0_20' } });

    fireEvent.click(screen.getByRole('button', { name: /generate preview/i }));
    expect(await screen.findByTestId('tvs-preview-filters')).toHaveTextContent('For: Jan 2026 · Programme: Gold · Billing bucket: Under 20%');
    expect(screen.getByRole('columnheader', { name: 'ASM Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Under 20%' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /download excel/i }));
    await screen.findByTestId('download-queued');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/admin/reports/target-vs-sales?fromMonth=2026-01&toMonth=2026-01&format=json&program=Gold&managerId=m1&bucket=P0_20');
    expect(urls).toContain('/api/admin/reports/target-vs-sales?fromMonth=2026-01&toMonth=2026-01&format=xlsx&program=Gold&managerId=m1&bucket=P0_20');
  });

  it('a failed filter-list load is shown, and the report still works unfiltered', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/filters')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 202, json: async () => ({ success: true, data: { exportRequestId: 'e4', message: 'Queued.' } }) };
    });
    render(<TargetVsSalesPage />);
    expect(await screen.findByTestId('tvs-filters-error')).toHaveTextContent(/Couldn.t load the filter lists/);
    expect(screen.getByRole('button', { name: /download excel/i })).toBeEnabled();
  });
});
