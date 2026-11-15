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
  it('fetch rejects → readable network error with the may-have-been-saved note', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<TargetUploadPage />);
    await upload();
    const msg = await screen.findByText(/Couldn't reach the server \(network error\)/);
    expect(msg.textContent).toMatch(/may have been saved — refresh and check before trying again/);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
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
