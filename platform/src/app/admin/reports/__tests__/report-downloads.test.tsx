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
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/reports/target-vs-sales?fromMonth=2026-01&toMonth=2026-06&format=xlsx');
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
