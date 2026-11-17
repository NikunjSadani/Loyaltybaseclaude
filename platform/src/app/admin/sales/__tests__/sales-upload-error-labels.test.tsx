/// <reference types="vitest/globals" />
/**
 * Achievements upload — error labelling.
 *  - Only a REJECTED fetch() is a network error ("Couldn't reach the server…").
 *  - A throw AFTER the server answered (e.g. normalizeRowsEcho on an odd shape) is NOT a network
 *    error — it gets a neutral "couldn't show the result" message.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

import SalesUploadPage from '../page';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(upload: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/admin/achievements/batches')) return json({ success: true, data: [] });
      if (url.startsWith('/api/admin/kpis')) return json({ success: true, data: [] });
      if (url.startsWith('/api/admin/achievements/upload')) return upload();
      return json({ success: false, error: 'unexpected' }, 404);
    }),
  );
}

async function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'ach.xlsx')] } }); });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  echo.throwIt = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('achievements upload — error labels', () => {
  it('fetch rejects → network-error message (never the raw "Failed to fetch")', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<SalesUploadPage />);
    await upload();
    expect(await screen.findByText(/Couldn't reach the server \(network error\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it('a throw after the server answered → neutral message, NOT "network error"', async () => {
    echo.throwIt = true;
    stubFetch(async () => json({ success: true, data: { batchId: 'b', month: '2026-10', monthsInBatch: [], totalRows: 0, acceptedCount: 0, rejectedCount: 0 } }));
    render(<SalesUploadPage />);
    await upload();
    const msg = await screen.findByText(/Something went wrong showing the upload result/);
    expect(msg.textContent).toMatch(/may have been saved — refresh and check/);
    expect(screen.queryByText(/network error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
  });
});
