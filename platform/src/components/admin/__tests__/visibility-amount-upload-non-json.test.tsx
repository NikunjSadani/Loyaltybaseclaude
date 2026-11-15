/// <reference types="vitest/globals" />
/**
 * VisibilityAmountUploadPanel — representative upload screen: a non-JSON response (proxy
 * truncation → plain-text 500, or an edge 413) used to throw inside `res.json()` and be
 * misreported as "Network error". It must now show a readable, honest message and stop the spinner.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { VisibilityAmountUploadPanel } from '../VisibilityAmountUploadPanel';

const plainText = (status: number) => ({
  ok: false,
  status,
  json: async () => {
    throw new SyntaxError(`Unexpected token 'I', "Internal S"... is not valid JSON`);
  },
});

function chooseAndUpload() {
  const input = screen.getByLabelText('Choose visibility upload file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'vis.xlsx')] } });
  fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
}

describe('VisibilityAmountUploadPanel — non-JSON responses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('plain-text 500 → readable "server didn\'t respond properly" + may-have-saved note, not "Network error"', async () => {
    global.fetch = vi.fn().mockResolvedValue(plainText(500)) as unknown as typeof fetch;
    render(<VisibilityAmountUploadPanel />);
    chooseAndUpload();

    const msg = await screen.findByText(/didn't respond properly \(HTTP 500\)/);
    expect(msg.textContent).toMatch(/may have been saved/);
    expect(screen.queryByText(/Network error/)).toBeNull();
    expect(screen.queryByText(/SyntaxError|Unexpected token/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Upload$/ })).toBeTruthy(); // spinner gone
  });

  it('non-JSON 413 → says the file is too large', async () => {
    global.fetch = vi.fn().mockResolvedValue(plainText(413)) as unknown as typeof fetch;
    render(<VisibilityAmountUploadPanel />);
    chooseAndUpload();
    expect(await screen.findByText(/file is too large/i)).toBeTruthy();
  });

  it('JSON success still renders the result (unchanged)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { batchId: 'b', rowCount: 3, successCount: 3, errorCount: 0, errorFileBase64: null } }),
    }) as unknown as typeof fetch;
    render(<VisibilityAmountUploadPanel />);
    chooseAndUpload();
    expect(await screen.findByText('All 3 rows uploaded successfully')).toBeTruthy();
  });
});
