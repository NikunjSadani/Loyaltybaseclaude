/// <reference types="vitest/globals" />
/**
 * Owner 2026-11-26: a target file whose focus brand NAME has a number in it ("1011.2697 & ADHO500") is refused by the
 * API with details { code: 'NUMERIC_FOCUS_NAMES', items }. The page shows the message, the first 20 rows (outlet,
 * month, column, number) and a download of EVERY row — never a silent "first N".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/targets/upload',
  useSearchParams: () => new URLSearchParams(),
}));
const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import TargetUploadPage from '../page';
import { numericFocusNamesCsv } from '@/components/admin/numeric-focus-names';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const items = Array.from({ length: 25 }, (_, i) => ({
  outletCode: `O${String(i).padStart(3, '0')}`, month: '2026-12', column: 'Focus Brand 1 Name', value: `${1000 + i}.26`,
  name: `${1000 + i}.26 & ADHO500`,
}));
const MSG = 'Focus brand names must be product names, not numbers — check column "Focus Brand 1 Name". 25 names have a number where a product should be: … Nothing was saved.';

function stub(body: unknown, status: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
    if (url.startsWith('/api/admin/targets/batches')) return json({ success: true, data: [] });
    if (url.startsWith('/api/admin/targets/upload')) return json(body, status);
    return json({ success: false, error: 'unexpected' }, 404);
  }));
}
async function pick() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['xlsx-bytes'], 't.xlsx')] } }); });
}

beforeEach(() => { vi.unstubAllGlobals(); downloadBlob.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('target upload — focus names that are numbers', () => {
  it('shows the refusal, the first 20 rows, "and 5 more", and downloads ALL 25 as CSV', async () => {
    stub({ success: false, error: MSG, details: { code: 'NUMERIC_FOCUS_NAMES', total: 25, columns: ['Focus Brand 1 Name'], items } }, 400);
    render(<TargetUploadPage />);
    await pick();
    expect(await screen.findByRole('alert')).toHaveTextContent('Focus brand names must be product names, not numbers');
    const box = screen.getByTestId('numeric-focus-names');
    expect(box).toHaveTextContent('25 focus brand names have a number where a product should be (“Focus Brand 1 Name”)');
    expect(within(box).getAllByTestId('numeric-focus-name-row')).toHaveLength(20);
    expect(within(box).getAllByTestId('numeric-focus-name-row')[0]).toHaveTextContent('O0002026-12Focus Brand 1 Name1000.261000.26 & ADHO500');
    expect(screen.getByTestId('numeric-focus-names-more')).toHaveTextContent('…and 5 more (in the download).');
    fireEvent.click(screen.getByRole('button', { name: 'Download the full list (25)' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe('focus-names-with-numbers.csv');
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
    expect(text.trim().split('\r\n')).toHaveLength(26); // header + every row
    expect(screen.queryByTestId('target-upload-preview')).not.toBeInTheDocument();
  });

  it('any other refusal shows no list', async () => {
    stub({ success: false, error: 'Invalid or corrupted xlsx file' }, 400);
    render(<TargetUploadPage />);
    await pick();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or corrupted xlsx file');
    expect(screen.queryByTestId('numeric-focus-names')).not.toBeInTheDocument();
  });

  it('old duplicate-header layout + an ignored empty column: the preview says both loudly', async () => {
    const TOKEN = `${'a'.repeat(64)}.${'b'.repeat(32)}.${'1'.repeat(13)}.${'c'.repeat(64)}`;
    stub({ success: true, data: {
      month: '2026-12', monthsInBatch: ['2026-12'], writableMonths: ['2026-12'], skippedLockedMonths: [], totalRows: 1,
      acceptedCount: 1, rejectedCount: 0, problemRows: [], problemRowCount: 0, problemRowsTruncated: false, warningRows: [],
      warningRowCount: 0, warningRowsTruncated: false, skippedBlankCount: 0, preview: true, previewToken: TOKEN,
      willSaveCount: 1, newCount: 1, overwriteCount: 0, perMonth: [{ month: '2026-12', newCount: 1, overwriteCount: 0 }],
      overwriteExamples: [], overwriteExamplesSampled: 0, notApplied: [], previewExpiresAt: '2026-11-26T07:00:00.000Z',
      layoutNotes: ['Read column F as Focus Brand 1 names (old template layout).'],
      ignoredColumnNotes: ['Column G "Notes" was not recognised and was ignored — re-download the template.'],
    } }, 200);
    render(<TargetUploadPage />);
    await pick();
    expect(await screen.findByTestId('target-upload-layout-notes'))
      .toHaveTextContent('Read column F as Focus Brand 1 names (old template layout).');
    expect(screen.getByTestId('target-upload-ignored-columns'))
      .toHaveTextContent('Column G "Notes" was not recognised and was ignored — re-download the template.');
  });

  it('CSV quotes names with commas / quotes', () => {
    expect(numericFocusNamesCsv([{ outletCode: 'O1', month: '2026-12', column: 'C', value: '1', name: '1,011 & "X"' }]))
      .toBe('Outlet ID,Month,Column,Number found,Name as written\r\nO1,2026-12,C,1,"1,011 & ""X"""\r\n');
  });
});
