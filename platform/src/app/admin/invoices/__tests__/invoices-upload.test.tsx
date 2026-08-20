/// <reference types="vitest/globals" />
/**
 * ADMIU — Admin "Generate Visibility Invoices" screen (/admin/invoices/upload)
 *
 * This screen replaced a legacy file-upload-of-period-names flow with a direct
 * month picker + Generate that calls the SAME backend, unchanged:
 *   POST /api/admin/invoices/generate  body { period: "YYYY-MM" }
 *
 * ADMIU1: Generate button is disabled until a valid period is picked
 * ADMIU2: picking a period + Generate POSTs { period } to the generate endpoint
 * ADMIU3: renders the generated count + skipped list from the backend result
 * ADMIU4: surfaces a backend error verbatim
 * ADMIU5: no file-upload affordance / template download remains on the page
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import InvoiceUploadPage from '../upload/page';

// authHeader() is a no-op stub in the app; keep the real import path intact.

afterEach(() => { vi.unstubAllGlobals(); });

/** Set the month input to a "YYYY-MM" value. */
function pickPeriod(value: string) {
  const input = document.getElementById('invoice-period') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('ADMIU — Generate Visibility Invoices (upload page)', () => {
  it('ADMIU1: Generate button is disabled until a valid period is picked', () => {
    render(<InvoiceUploadPage />);
    const btn = screen.getByRole('button', { name: /generate invoices/i });
    expect(btn).toBeDisabled();

    pickPeriod('2026-07');
    expect(btn).toBeEnabled();
  });

  it('ADMIU2: picking a period + Generate POSTs { period } to the generate endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { generated: 3, skipped: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InvoiceUploadPage />);
    pickPeriod('2026-07');
    fireEvent.click(screen.getByRole('button', { name: /generate invoices/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/invoices/generate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ period: '2026-07' });
  });

  it('ADMIU3: renders the generated count + skipped list from the backend result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          generated: 2,
          skipped: [{ outletCode: 'OUT009', reason: 'No confirmed payout' }],
        },
      }),
    }));

    render(<InvoiceUploadPage />);
    pickPeriod('2026-07');
    fireEvent.click(screen.getByRole('button', { name: /generate invoices/i }));

    expect(await screen.findByText(/2 Invoices Generated/i)).toBeInTheDocument();
    expect(screen.getByText('OUT009')).toBeInTheDocument();
    expect(screen.getByText(/no confirmed payout/i)).toBeInTheDocument();
  });

  it('ADMIU4: surfaces a backend error verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ success: false, error: 'Period is closed for invoicing' }),
    }));

    render(<InvoiceUploadPage />);
    pickPeriod('2026-07');
    fireEvent.click(screen.getByRole('button', { name: /generate invoices/i }));

    expect(await screen.findByText('Period is closed for invoicing')).toBeInTheDocument();
  });

  it('ADMIU5: no file-upload input or template download remains on the page', () => {
    render(<InvoiceUploadPage />);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/download.*template/i)).not.toBeInTheDocument();
  });
});
