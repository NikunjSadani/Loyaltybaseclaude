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
    expect(await screen.findByText('Upload files')).toBeTruthy();
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

    const summary = await screen.findByText(/^Uploaded 2 of 4 file\(s\)\./);
    // c.jpg (readable 400) is a definite failure → "re-select"; b.jpg (unreadable 500) may have landed → "check first".
    expect(summary.textContent).toBe(
      "Uploaded 2 of 4 file(s). 1 failed and wasn't saved — re-select only that file. " +
        "1 may or may not have been saved — check the evidence list below first; re-select it only if it's missing.",
    );
    expect(posted).toHaveLength(4); // d.jpg still attempted after the failures

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/b\.jpg/);
    expect(alert.textContent).toMatch(/didn't respond properly \(HTTP 500\)/);
    expect(alert.textContent).toMatch(/may or may not have been saved/);
    expect(alert.textContent).toMatch(/c\.jpg/);
    expect(alert.textContent).toMatch(/Not a real JPEG/);
    expect(alert.textContent).not.toMatch(/a\.jpg|d\.jpg/);
    expect(alert.textContent).not.toMatch(/SyntaxError|Unexpected token/);
    const items = Array.from(alert.querySelectorAll('li'));
    expect(items.find((li) => li.textContent?.startsWith('b.jpg'))?.getAttribute('data-unsure')).toBe('true');
    expect(items.find((li) => li.textContent?.startsWith('c.jpg'))?.getAttribute('data-unsure')).toBe('false');
  });

  it('a non-JSON 413 is a definite "too large" failure; a network error is "unsure" (may have landed)', async () => {
    mockFetch(async (f) => {
      if (f.name === 'big.jpg') return plainText(413);
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');

    pick(container, [jpg('big.jpg'), jpg('net.jpg')]);

    const summary = await screen.findByText(/^Uploaded 0 of 2 file\(s\)\./);
    expect(summary.textContent).toMatch(/1 failed and wasn't saved — re-select only that file/);
    expect(summary.textContent).toMatch(/1 may or may not have been saved — check the evidence list below first/);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/big\.jpg.*file is too large/i);
    expect(alert.textContent).toMatch(/net\.jpg.*Couldn't reach the server/);
    expect(await screen.findByText('Upload files')).toBeTruthy();
  });

  it('only unsure failures → never tells the operator to blindly re-select', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');
    pick(container, [jpg('a.jpg'), jpg('b.jpg')]);
    const summary = await screen.findByText(/^Uploaded 0 of 2 file\(s\)\./);
    expect(summary.textContent).toBe(
      'Uploaded 0 of 2 file(s). 2 may or may not have been saved — check the evidence list below first; re-select only the ones that are missing.',
    );
    expect(summary.textContent).not.toMatch(/wasn't saved|weren't saved/);
  });

  it('the pre-check error is an alert; the progress live region is always mounted', async () => {
    mockFetch(async () => okRes());
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete />);
    await screen.findByText('No audit evidence uploaded yet.');
    // Live region exists BEFORE any upload starts.
    expect((await screen.findByTestId('evidence-upload-progress')).getAttribute('aria-live')).toBe('polite');
    pick(container, [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/notes\.txt.*not a JPG/);
  });

  it('reports uploading start/end to the parent, and warns on page unload while uploading', async () => {
    let release!: () => void;
    mockFetch(() => new Promise((resolve) => { release = () => resolve(okRes()); }));
    const onUploadingChange = vi.fn();
    const { container } = render(<BatchEvidencePanel batchId="b1" canDelete onUploadingChange={onUploadingChange} />);
    await screen.findByText('No audit evidence uploaded yet.');
    pick(container, [jpg('a.jpg')]);

    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(true));
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    release();
    await screen.findByText('Uploaded 1 of 1 file(s).');
    expect(onUploadingChange).toHaveBeenLastCalledWith(false);
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it('unmount mid-upload aborts the in-flight request, stops the loop and sets no state', async () => {
    const signals: AbortSignal[] = [];
    let posts = 0;
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init || !init.method || init.method === 'GET') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { attachments: [] } }) });
      }
      posts += 1;
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUploadingChange = vi.fn();
    const { container, unmount } = render(
      <BatchEvidencePanel batchId="b1" canDelete onUploadingChange={onUploadingChange} />,
    );
    await screen.findByText('No audit evidence uploaded yet.');
    pick(container, [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')]);
    await waitFor(() => expect(posts).toBe(1));

    unmount();
    expect(signals[0].aborted).toBe(true);
    expect(onUploadingChange).toHaveBeenLastCalledWith(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toBe(1); // b.jpg / c.jpg never sent
    expect(errSpy.mock.calls.flat().join(' ')).not.toMatch(/unmounted component|act\(/);
    errSpy.mockRestore();
  });
});
