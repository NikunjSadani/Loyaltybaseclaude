/// <reference types="vitest/globals" />
/**
 * VisibilityAmountUploadPanel — "Download Report" used to request `limit=10000` against the records API's
 * 100-row cap (→ 400) and silently do nothing. It must page in ≤100-row requests until `total` is read,
 * and show a readable error when a page fails.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', async (orig) => ({ ...(await orig<Record<string, unknown>>()), downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

import { VisibilityAmountUploadPanel } from '../VisibilityAmountUploadPanel';

const rec = (i: number) => ({ outletCode: `O${i}`, month: '2026-11', status: 'APPROVED', dateOfCapture: null, approvedBy: null, uploadBatch: null });

describe('VisibilityAmountUploadPanel — report download', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pages in 100-row requests until total is read (250 records → 3 requests)', async () => {
    const TOTAL = 250;
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x');
      const limit = Number(u.searchParams.get('limit'));
      const page = Number(u.searchParams.get('page'));
      expect(limit).toBeLessThanOrEqual(100);
      const start = (page - 1) * limit;
      const records = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - start)) }, (_, i) => rec(start + i));
      return { ok: true, status: 200, json: async () => ({ success: true, data: { records, total: TOTAL, page, limit } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<VisibilityAmountUploadPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Download Report/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Download Report/ })).toBeTruthy(), { timeout: 15000 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 15000 });
    expect(screen.queryByTestId('visibility-report-error')).toBeNull();
  }, 20000);

  it('a failing page shows a readable error instead of silently doing nothing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }) as unknown as typeof fetch;
    render(<VisibilityAmountUploadPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Download Report/ }));
    expect(await screen.findByText(/Couldn't download the report \(error 400\)/, {}, { timeout: 15000 })).toBeTruthy();
  }, 20000);
});
