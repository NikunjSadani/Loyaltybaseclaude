/// <reference types="vitest/globals" />
/**
 * BatchEvidencePanel — ONE file per upload request.
 *
 * Up to 5 × 10 MB in one multipart body could exceed the Next proxy's body cap (silently
 * truncated → plain-text 500 ~30 s later). The panel now uploads each file in its own request,
 * sequentially; a failed file is reported by name and never costs the operator the others.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import BatchEvidencePanel from '../BatchEvidencePanel';

const LIST_URL = '/api/admin/credits/batches/b1/attachments';

type Handler = (file: File) => Promise<unknown>;

function jpg(name: string) {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' });
}

/** Routes GET (list) → empty list; POST → `onUpload(theSingleFile)`. Records each POST's files. */
function mockFetch(onUpload: Handler) {
  const posted: File[][] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === LIST_URL && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { attachments: [] } }) };
    }
    if (url === LIST_URL && init?.method === 'POST') {
      const files = (init.body as FormData).getAll('files') as File[];
      posted.push(files);
      return onUpload(files[0]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return posted;
}

const okRes = () => ({ ok: true, status: 201, json: async () => ({ success: true, data: { attachments: [] } }) });
const plainText = (status: number) => ({
  ok: false,
  status,
  json: async () => {
    throw new SyntaxError(`Unexpected token 'I', "Internal S"... is not valid JSON`);
  },
});

function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe('BatchEvidencePanel — one file per request', () => {
  beforeEach(() => vi.clearAllMocks());

  it('N files → N POST requests, each carrying exactly one file, then a success summary', async () => {
    const posted = mockFetch(async () => okRes());
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');

    const files = [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'), jpg('d.jpg'), jpg('e.jpg'), jpg('f.jpg'), jpg('g.jpg')];
    pick(container, files);

    expect(await screen.findByText('Uploaded 7 of 7 file(s).')).toBeTruthy();
    expect(posted).toHaveLength(7);
    for (const p of posted) expect(p).toHaveLength(1);
    expect(posted.map((p) => p[0].name)).toEqual(files.map((f) => f.name));
    // Upload button back to idle.
    expect(screen.getByText('Upload files')).toBeTruthy();
  });

  it('a failed file is reported by name; the files after it are still uploaded', async () => {
    const posted = mockFetch(async (f) => {
      if (f.name === 'b.jpg') return plainText(500);
      if (f.name === 'c.jpg') return { ok: false, status: 400, json: async () => ({ success: false, error: 'Not a real JPEG' }) };
      return okRes();
    });
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');

    pick(container, [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg'), jpg('d.jpg')]);

    const summary = await screen.findByText(/Uploaded 2 of 4 file\(s\)\. 2 failed/);
    expect(summary).toBeTruthy();
    expect(posted).toHaveLength(4); // d.jpg still attempted after the failures

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/b\.jpg/);
    expect(status.textContent).toMatch(/didn't respond properly \(HTTP 500\)/);
    expect(status.textContent).toMatch(/may or may not have been saved/);
    expect(status.textContent).toMatch(/c\.jpg/);
    expect(status.textContent).toMatch(/Not a real JPEG/);
    expect(status.textContent).not.toMatch(/a\.jpg|d\.jpg/);
    expect(status.textContent).not.toMatch(/SyntaxError|Unexpected token/);
  });

  it('a non-JSON 413 says the file is too large; a network error is readable', async () => {
    mockFetch(async (f) => {
      if (f.name === 'big.jpg') return plainText(413);
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');

    pick(container, [jpg('big.jpg'), jpg('net.jpg')]);

    await screen.findByText(/Uploaded 0 of 2 file\(s\)\. 2 failed/);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/big\.jpg.*file is too large/i);
    expect(status.textContent).toMatch(/net\.jpg.*Couldn't reach the server/);
    await waitFor(() => expect(screen.getByText('Upload files')).toBeTruthy());
  });
});
