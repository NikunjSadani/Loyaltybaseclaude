/// <reference types="vitest/globals" />
/**
 * SCF — the sales Catalogue loads every API page (200 per page) and a failed load is an error with Retry,
 * never "No gifts found". Regression 2026-11-27 (API default page of 20 hid items past the 20 cheapest).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CataloguePage from '../page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));

const item = (i: number) => ({
  id: `g${i}`, name: `Gift ${i}`, pointsCost: 500 + i, description: null, imageUrls: null,
  status: 'ACTIVE', stockQuantity: null, redemptionMode: 'PHYSICAL_GIFT',
});
const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });

function stub(catalog: (page: number, call: number) => Promise<unknown>) {
  let calls = 0;
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/rewards/catalog')) {
      urls.push(url);
      return catalog(Number(new URL(url, 'http://x').searchParams.get('page') ?? '1'), ++calls);
    }
    if (url.includes('/api/sales/outlets')) return ok({ outlets: [] });
    return ok({});
  }));
  return urls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SCF — sales catalogue full load', () => {
  it('SCF1: loads both pages at 200 per page', async () => {
    const urls = stub((page) => ok(page === 1
      ? { items: [item(1)], pagination: { page: 1, limit: 200, total: 2, pages: 2 } }
      : { items: [item(2)], pagination: { page: 2, limit: 200, total: 2, pages: 2 } }));
    render(<CataloguePage />);
    expect(await screen.findByText('Gift 1')).toBeInTheDocument();
    expect(await screen.findByText('Gift 2')).toBeInTheDocument();
    expect(urls).toEqual(['/api/rewards/catalog?page=1&limit=200', '/api/rewards/catalog?page=2&limit=200']);
  });

  it('SCF2: a failed load shows an error + Retry, not "No gifts found"; Retry recovers', async () => {
    stub((_p, call) => call === 1
      ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })
      : ok({ items: [item(9)], pagination: { page: 1, limit: 200, total: 1, pages: 1 } }));
    render(<CataloguePage />);
    expect(await screen.findByTestId('catalogue-load-error')).toBeInTheDocument();
    expect(screen.queryByText('No gifts found.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Gift 9')).toBeInTheDocument();
  });
});
