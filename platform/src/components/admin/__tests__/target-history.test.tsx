/// <reference types="vitest/globals" />
/**
 * Target history (owner 2026-11-25): one outlet's changes (month, KPI, old → new, by, when, upload), the "recorded
 * from … / before history tracking" note (never a silent gap), paging, errors, and the report download URLs.
 * Run: npx vitest run src/components/admin/__tests__/target-history.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TargetHistoryCard, TargetHistoryPanel } from '../target-history';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, outletCode: 'R1', month: '2026-12', kpiCode: 'MONTH_TGT', kpiLabel: 'Month Target', field: 'VALUE',
  oldValue: 10, newValue: 12, changeType: 'UPDATED', batchId: 'cmbatch00000001', batchFileKept: true,
  changedByName: 'Asha Admin', changedAt: '2026-11-26T06:30:00.000Z', ...extra,
});
const page = (items: unknown[], more: string | null = null, trackingSince: string | null = '2026-11-25T12:00:00.000Z') =>
  ({ success: true, data: { items, pageSize: 100, hasMore: more !== null, nextCursor: more, trackingSince } });

let fetchMock: ReturnType<typeof vi.fn>;
function stub(handler: (url: string) => Promise<Response>) {
  fetchMock = vi.fn(async (url: string) => handler(url));
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe('Target history panel', () => {
  it('lists the outlet changes: month, KPI, old → new, who, when (IST), upload file link', async () => {
    stub(async () => json(page([
      row('h3'),
      row('h2', { kpiCode: 'FP1', kpiLabel: 'Focus Pack', oldValue: 5, newValue: null, changeType: 'DELETED', batchFileKept: false }),
      row('h1', { oldValue: null, newValue: 7, changeType: 'CREATED', field: 'NAME' }),
    ])));
    render(<TargetHistoryPanel outletCode="R1" />);
    const table = await screen.findByRole('table');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/targets/history?outletCode=R1');
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(3);
    expect(body[0]).toHaveTextContent("Dec '26");
    expect(body[0]).toHaveTextContent('Month Target');
    expect(body[0]).toHaveTextContent('10 → 12');
    expect(body[0]).toHaveTextContent('Asha Admin');
    expect(body[0]).toHaveTextContent(/26 Nov 2026, 12:00 pm/i);
    expect(within(body[0]).getByRole('button', { name: 'Upload file' })).toBeInTheDocument();
    expect(body[1]).toHaveTextContent('5 → removed');
    expect(body[1]).toHaveTextContent('Upload 00000001'); // file not kept → the upload reference, no link
    expect(body[2]).toHaveTextContent('— → 7');
    expect(body[2]).toHaveTextContent('(custom name)');
    expect(body[2]).toHaveTextContent('(new)');
  });

  it('shows FULL precision (a real change never looks unchanged), without trailing zeros', async () => {
    stub(async () => json(page([row('h1', { oldValue: 12.3456, newValue: 12.3457 }), row('h0', { oldValue: 12.5, newValue: 1250000.125 })])));
    render(<TargetHistoryPanel outletCode="R1" />);
    const body = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    expect(body[0]).toHaveTextContent('12.3456 → 12.3457');
    expect(body[1]).toHaveTextContent('12.5 → 12,50,000.125');
  });

  it('ALWAYS says from when history is recorded (changes before that are not listed)', async () => {
    stub(async () => json(page([])));
    render(<TargetHistoryPanel outletCode="R1" />);
    expect(await screen.findByTestId('target-history-tracking'))
      .toHaveTextContent(/recorded from 25 Nov 2026, 0?5:30 pm IST\. Changes made before then are not listed/i);
    expect(screen.getByText('No recorded target changes for this outlet.')).toBeInTheDocument();
  });

  it('no changes recorded yet in the program → says history tracking has recorded nothing yet', async () => {
    stub(async () => json(page([], null, null)));
    render(<TargetHistoryPanel outletCode="R1" />);
    expect(await screen.findByTestId('target-history-tracking')).toHaveTextContent('No target changes have been recorded yet.');
  });

  it('pages: "showing the newest 100" + Load older changes appends the next page', async () => {
    const first = Array.from({ length: 100 }, (_, i) => row(`p${i}`));
    stub(async (url) => (url.includes('before=p99') ? json(page([row('last')])) : json(page(first, 'p99'))));
    render(<TargetHistoryPanel outletCode="R1" />);
    expect(await screen.findByTestId('target-history-count')).toHaveTextContent('Showing the newest 100 changes');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load older changes' })); });
    expect(fetchMock.mock.calls.map(c => c[0])).toContain('/api/admin/targets/history?outletCode=R1&before=p99');
    expect(screen.getByTestId('target-history-count')).toHaveTextContent('Showing all 101 recorded changes.');
  });

  it('a server error is shown (never an empty "no changes" list)', async () => {
    stub(async () => json({ success: false, error: 'Forbidden resource' }, 403));
    render(<TargetHistoryPanel outletCode="R1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden resource');
    expect(screen.queryByText('No recorded target changes for this outlet.')).not.toBeInTheDocument();
  });

  it("the outlet's download asks for that outlet's report", async () => {
    stub(async (url) => url.startsWith('/api/admin/targets/history/export')
      ? new Response(new Blob(['xlsx']), { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
      : json(page([])));
    render(<TargetHistoryPanel outletCode="R 1" />);
    await screen.findByTestId('target-history-tracking');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download this outlet's history/ })); });
    expect(fetchMock.mock.calls.map(c => c[0])).toContain('/api/admin/targets/history/export?outletCode=R+1');
  });
});

describe('Target history card (Targets pages)', () => {
  it('links to the per-outlet page and downloads the whole program report', async () => {
    stub(async () => new Response(JSON.stringify({ success: true, data: { queued: true } }), { status: 202 }));
    render(<TargetHistoryCard />);
    expect(screen.getByRole('link', { name: "See an outlet's history" })).toHaveAttribute('href', '/admin/targets/history');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Download target history/ })); });
    expect(fetchMock.mock.calls.map(c => c[0])).toContain('/api/admin/targets/history/export');
  });
});
