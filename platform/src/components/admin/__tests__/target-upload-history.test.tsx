/// <reference types="vitest/globals" />
/**
 * Targets — Upload history: rows (IST time, who, months, counts), "Download file" for kept files, "File not kept"
 * for older uploads, the failed tag, and the loading / empty / error states.
 * Run: npx vitest run src/components/admin/__tests__/target-upload-history.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TargetUploadHistory } from '../target-upload-history';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const rows = [
  {
    id: 'tgtup_new', createdAt: '2026-11-25T06:30:00.000Z', month: '2026-12', status: 'COMPLETED',
    totalRows: 10, acceptedCount: 8, rejectedCount: 2, uploadedByName: 'Asha Admin', months: ['2026-12', '2027-01'],
    fileName: 'dec.xlsx', newCount: 3, overwriteCount: 5, fileKept: true,
  },
  {
    id: 'old1', createdAt: '2026-10-01T10:00:00.000Z', month: '2026-10', status: 'COMPLETED',
    totalRows: 4, acceptedCount: 4, rejectedCount: 0, uploadedByName: 'Gifsy team', months: null,
    fileName: null, newCount: null, overwriteCount: null, fileKept: false,
  },
  {
    id: 'tgtup_failed', createdAt: '2026-11-20T10:00:00.000Z', month: '2026-12', status: 'FAILED',
    totalRows: 1, acceptedCount: 1, rejectedCount: 0, uploadedByName: 'Asha Admin', months: ['2026-12'],
    newCount: 1, overwriteCount: 0, fileKept: false,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
function stub(list: () => Promise<Response>) {
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/admin/targets/batches') return list();
    if (url.startsWith('/api/admin/targets/batches/')) {
      return new Response(new Blob(['xlsx']), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="dec.xlsx"' },
      });
    }
    return json({ success: false, error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // jsdom has no object URLs — the download helper needs them to save the file.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe('Target upload history', () => {
  it('lists uploads: IST time, who, months, counts; Download file only when the file was kept', async () => {
    stub(async () => json({ success: true, data: rows }));
    render(<TargetUploadHistory />);
    const table = await screen.findByRole('table');
    const body = within(table).getAllByRole('row').slice(1);
    expect(body).toHaveLength(3);

    // 06:30 UTC = 12:00 pm IST
    expect(body[0]).toHaveTextContent(/25 Nov 2026, 12:00 pm/i);
    expect(body[0]).toHaveTextContent('Asha Admin');
    expect(body[0]).toHaveTextContent("Dec '26, Jan '27");
    expect(within(body[0]).getAllByRole('cell').map(c => c.textContent).slice(3, 6)).toEqual(['8', '2', '5']);
    expect(within(body[0]).getByRole('button', { name: 'Download file' })).toBeInTheDocument();

    // older upload: falls back to the batch month, overwritten unknown, file not kept
    expect(body[1]).toHaveTextContent('Gifsy team');
    expect(body[1]).toHaveTextContent("Oct '26");
    expect(within(body[1]).getAllByRole('cell')[5]).toHaveTextContent('—');
    expect(body[1]).toHaveTextContent('File not kept');
    expect(within(body[1]).queryByRole('button')).not.toBeInTheDocument();

    expect(body[2]).toHaveTextContent('Failed — not fully applied');
    expect(body[2]).toHaveTextContent('File not kept');
  });

  it('"Download file" fetches the kept file of THAT upload', async () => {
    stub(async () => json({ success: true, data: rows }));
    render(<TargetUploadHistory />);
    const btn = await screen.findByRole('button', { name: 'Download file' });
    await act(async () => { fireEvent.click(btn); });
    const urls = fetchMock.mock.calls.map(c => c[0] as string);
    expect(urls).toContain('/api/admin/targets/batches/tgtup_new/file');
  });

  it('loading → empty state', async () => {
    let release!: (r: Response) => void;
    stub(() => new Promise<Response>(r => { release = r; }));
    render(<TargetUploadHistory />);
    expect(screen.getByText('Loading upload history…')).toBeInTheDocument();
    await act(async () => { release(json({ success: true, data: [] })); });
    expect(await screen.findByText('No target uploads yet.')).toBeInTheDocument();
  });

  it('a server error is shown (never an empty "no uploads" list)', async () => {
    stub(async () => json({ success: false, error: 'Forbidden resource' }, 403));
    render(<TargetUploadHistory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden resource');
    expect(screen.queryByText('No target uploads yet.')).not.toBeInTheDocument();
  });

  it('reloads when refreshKey changes (after an apply)', async () => {
    stub(async () => json({ success: true, data: [] }));
    const { rerender } = render(<TargetUploadHistory refreshKey={0} />);
    await screen.findByText('No target uploads yet.');
    rerender(<TargetUploadHistory refreshKey={1} />);
    await screen.findByText('No target uploads yet.');
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/admin/targets/batches')).toHaveLength(2);
  });
});
