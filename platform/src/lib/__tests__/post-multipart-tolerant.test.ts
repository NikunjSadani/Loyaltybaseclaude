/// <reference types="vitest/globals" />
/**
 * postMultipart (lib/schemes.ts + lib/visibility.ts) — tolerant of non-JSON responses.
 *
 * Before: `await res.json()` on a plain-text "Internal Server Error" threw, and the raw
 * `SyntaxError: Unexpected token 'I'…` was passed up as the error text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMultipart as schemesPost, schemeApi } from '@/lib/schemes';
import { postMultipart as visibilityPost, visibilityApi } from '@/lib/visibility';
import {
  FILE_TOO_LARGE_MESSAGE,
  MAYBE_SAVED_NOTE,
  NOTHING_SAVED_NOTE,
  PHOTO_UPLOAD_RETRY_NOTE,
} from '@/lib/safe-response';

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

  it('uses the caller-supplied failureNote for network and unreadable-response failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const a = await postMultipart('/api/x', form(), PHOTO_UPLOAD_RETRY_NOTE);
    expect(a).toMatchObject({ success: false, error: `Couldn't reach the server (network error). ${PHOTO_UPLOAD_RETRY_NOTE}` });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 502 })));
    const b = await postMultipart('/api/x', form(), NOTHING_SAVED_NOTE);
    expect(b).toMatchObject({ success: false, error: `The server didn't respond properly (HTTP 502). ${NOTHING_SAVED_NOTE}` });
  });

  it('prefers the Nest `message` over a generic `error` phrase for a JSON 4xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'file must be an image' }), { status: 400 }),
    ));
    expect(await postMultipart('/api/x', form())).toEqual({ success: false, error: 'file must be an image' });
  });
});

/* ─── Each real caller passes the note that matches what its request does ─── */
describe('postMultipart callers — failure note per request type', () => {
  const file = () => new File([new Uint8Array([1])], 'f.jpg', { type: 'image/jpeg' });
  const rejectFetch = () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

  it.each([
    ['visibility sales capture photo', () => visibilityApi.uploadSalesMedia(file(), 'f.jpg')],
    ['visibility admin sample image', () => visibilityApi.uploadMedia(file())],
    ['scheme enrollment photo', () => schemeApi.uploadMedia('s1', file(), 'f.jpg')],
  ])('%s → photo-retry note (never "refresh")', async (_n, call) => {
    rejectFetch();
    const r = await call();
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain(PHOTO_UPLOAD_RETRY_NOTE);
    expect(r.error).not.toMatch(/refresh|may have been saved/i);
  });

  it('roster remove DRY RUN → nothing-saved note', async () => {
    rejectFetch();
    const r = await schemeApi.removeRosterByUpload('s1', file(), { dryRun: true });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain(NOTHING_SAVED_NOTE);
    expect(r.error).not.toContain(MAYBE_SAVED_NOTE);
  });

  it.each([
    ['roster remove (apply)', () => schemeApi.removeRosterByUpload('s1', file(), { dryRun: false })],
    ['roster upload', () => schemeApi.uploadRoster('s1', file())],
  ])('%s → may-have-been-saved note', async (_n, call) => {
    rejectFetch();
    const r = await call();
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain(MAYBE_SAVED_NOTE);
  });
});
