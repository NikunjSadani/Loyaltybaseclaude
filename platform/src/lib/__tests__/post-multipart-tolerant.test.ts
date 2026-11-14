/// <reference types="vitest/globals" />
/**
 * postMultipart (lib/schemes.ts + lib/visibility.ts) — tolerant of non-JSON responses.
 *
 * Before: `await res.json()` on a plain-text "Internal Server Error" threw, and the raw
 * `SyntaxError: Unexpected token 'I'…` was passed up as the error text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMultipart as schemesPost } from '@/lib/schemes';
import { postMultipart as visibilityPost } from '@/lib/visibility';
import { FILE_TOO_LARGE_MESSAGE } from '@/lib/safe-response';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  ['schemes', schemesPost],
  ['visibility', visibilityPost],
])('%s postMultipart', (_name, postMultipart) => {
  const form = () => {
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.jpg');
    return fd;
  };

  it('passes a JSON success envelope through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { id: 'm1' } }), { status: 201 }),
    ));
    expect(await postMultipart('/api/x', form())).toEqual({ success: true, data: { id: 'm1' } });
  });

  it('keeps the server error text for a JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Only JPG allowed' }), { status: 400 }),
    ));
    expect(await postMultipart('/api/x', form())).toEqual({ success: false, error: 'Only JPG allowed' });
  });

  it('returns a readable message (no SyntaxError) for a plain-text 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })));
    const r = await postMultipart('/api/x', form());
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/didn't respond properly \(HTTP 500\)/);
    expect(r.error).not.toMatch(/SyntaxError|Unexpected token/);
  });

  it('says the file is too large for a non-JSON 413', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>413</html>', { status: 413 })));
    const r = await postMultipart('/api/x', form());
    expect(r).toMatchObject({ success: false, error: FILE_TOO_LARGE_MESSAGE, status: 413 });
  });

  it('returns a readable network-error message when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const r = await postMultipart('/api/x', form());
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/Couldn't reach the server/);
  });
});
