/// <reference types="vitest/globals" />
/**
 * Target upload — fetch() itself rejecting must show a readable network-error message (the upload
 * writes targets, so it says they may have been saved), never the raw "Failed to fetch". A throw
 * after the server answered gets a neutral "couldn't show the result" message.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/targets/upload',
  useSearchParams: () => new URLSearchParams(),
}));

const echo = vi.hoisted(() => ({ throwIt: false }));
vi.mock('@/lib/upload-rows-echo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/upload-rows-echo')>();
  return {
    ...mod,
    normalizeRowsEcho: vi.fn((r: unknown) => {
      if (echo.throwIt) throw new TypeError("Cannot read properties of undefined (reading 'map')");
      return (mod.normalizeRowsEcho as (x: unknown) => unknown)(r);
    }),
  };
});

import TargetUploadPage from '../page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(upload: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
      if (url.startsWith('/api/admin/targets/upload')) return upload();
      return json({ success: false, error: 'unexpected' }, 404);
    }),
  );
}

async function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'targets.xlsx')] } }); });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  echo.throwIt = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('target upload — error labels', () => {
  it('PREVIEW fetch rejects → readable network error that says NOTHING was saved (the preview never writes)', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<TargetUploadPage />);
    await upload();
    const msg = await screen.findByText(/Couldn't reach the server \(network error\)/);
    expect(msg.textContent).toMatch(/Nothing was saved/);
    expect(msg.textContent).not.toMatch(/may have been saved/);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('CONFIRM fetch rejects → the may-have-been-saved note, and Confirm can be retried safely', async () => {
    let call = 0;
    stubFetch(async () => {
      call++;
      if (call === 1) {
        return json({ success: true, data: {
          preview: true, previewToken: `${'a'.repeat(64)}.${'b'.repeat(32)}`, month: '2026-12', monthsInBatch: ['2026-12'],
          writableMonths: ['2026-12'], totalRows: 1, acceptedCount: 1, rejectedCount: 0, willSaveCount: 1,
          newCount: 1, overwriteCount: 0, notApplied: [],
          problemRows: [], problemRowCount: 0, problemRowsTruncated: false,
          warningRows: [], warningRowCount: 0, warningRowsTruncated: false, skippedBlankCount: 0,
        } });
      }
      throw new TypeError('Failed to fetch');
    });
    render(<TargetUploadPage />);
    await upload();
    const confirm = await screen.findByRole('button', { name: /Confirm & apply/ });
    await act(async () => { fireEvent.click(confirm); });
    const msg = await screen.findByText(/Couldn't reach the server \(network error\)/);
    expect(msg.textContent).toMatch(/may have been saved — refresh and check before trying again/);
    // the preview stays and Confirm is re-armed (a second apply of the same preview is refused by the server)
    expect(screen.getByRole('button', { name: /Confirm & apply/ })).toBeEnabled();
  });

  it('a throw after the server answered → neutral message, not the raw exception', async () => {
    echo.throwIt = true;
    stubFetch(async () => json({ success: true, data: { batchId: 'b', month: '2026-10', monthsInBatch: [] } }));
    render(<TargetUploadPage />);
    await upload();
    expect(await screen.findByText(/Something went wrong showing the upload result/)).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();
  });
});
