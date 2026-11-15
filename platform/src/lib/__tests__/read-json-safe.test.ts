/// <reference types="vitest/globals" />
/**
 * api-client tolerant body helpers (memory-safety / proxy-truncation fix).
 *
 * A proxied request body over the Next proxy's cap is truncated → the caller later gets a
 * plain-text "Internal Server Error" (or an edge 413). `readJsonSafe` must never throw on that,
 * and `responseErrorMessage` must turn it into a readable, honest message.
 */
import { describe, it, expect } from 'vitest';
import {
  readJsonSafe,
  serverErrorText,
  responseErrorMessage,
  networkErrorMessage,
  FILE_TOO_LARGE_MESSAGE,
  NOTHING_SAVED_NOTE,
  MAYBE_SAVED_NOTE,
} from '@/lib/safe-response';

describe('readJsonSafe', () => {
  it('parses a JSON body', async () => {
    const res = new Response(JSON.stringify({ success: true, data: { a: 1 } }), { status: 200 });
    expect(await readJsonSafe(res)).toEqual({ success: true, data: { a: 1 } });
  });

  it('returns null (never throws) for a plain-text 500 body', async () => {
    const res = new Response('Internal Server Error', { status: 500 });
    await expect(readJsonSafe(res)).resolves.toBeNull();
  });

  it('returns null for an empty body and for 204', async () => {
    expect(await readJsonSafe(new Response('', { status: 200 }))).toBeNull();
    expect(await readJsonSafe(new Response(null, { status: 204 }))).toBeNull();
  });

  it('returns null for an HTML 413 page', async () => {
    const res = new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413 });
    expect(await readJsonSafe(res)).toBeNull();
  });
});

describe('serverErrorText', () => {
  it('prefers the envelope `error`, then Nest `message` (string or array)', () => {
    expect(serverErrorText({ success: false, error: 'Bad file' })).toBe('Bad file');
    expect(serverErrorText({ message: 'Oops' })).toBe('Oops');
    expect(serverErrorText({ message: ['a', 'b'] })).toBe('a; b');
    expect(serverErrorText(null)).toBeNull();
    expect(serverErrorText({ success: false })).toBeNull();
  });

  it('prefers a meaningful `message` when `error` is only a generic HTTP phrase (Nest default body)', () => {
    expect(serverErrorText({ statusCode: 400, error: 'Bad Request', message: 'Header row missing' })).toBe('Header row missing');
    expect(serverErrorText({ statusCode: 400, error: 'Bad Request', message: ['a', 'b'] })).toBe('a; b');
    expect(serverErrorText({ statusCode: 413, error: 'Payload Too Large', message: 'File exceeds 10 MB' })).toBe('File exceeds 10 MB');
    // Generic phrase with no (or the same) message → keep the phrase.
    expect(serverErrorText({ statusCode: 404, error: 'Not Found' })).toBe('Not Found');
    expect(serverErrorText({ error: 'Forbidden', message: 'Forbidden' })).toBe('Forbidden');
    // A specific `error` still wins over `message`.
    expect(serverErrorText({ error: 'Row 3: bad UTR', message: 'Bad Request' })).toBe('Row 3: bad UTR');
  });
});

describe('responseErrorMessage', () => {
  it('uses the server error text when the body is JSON', () => {
    expect(responseErrorMessage({ status: 400 }, { success: false, error: 'Row 3: bad UTR' })).toBe('Row 3: bad UTR');
  });

  it('says the file is too large on a non-JSON 413', () => {
    expect(responseErrorMessage({ status: 413 }, null)).toBe(FILE_TOO_LARGE_MESSAGE);
  });

  it('says the server did not respond properly + the caller-supplied saved note', () => {
    const msg = responseErrorMessage({ status: 500 }, null, NOTHING_SAVED_NOTE);
    expect(msg).toMatch(/didn't respond properly \(HTTP 500\)/);
    expect(msg).toContain(NOTHING_SAVED_NOTE);
    expect(msg).not.toMatch(/SyntaxError|Unexpected token/);
    expect(responseErrorMessage({ status: 502 }, null)).toContain(MAYBE_SAVED_NOTE);
  });

  it('networkErrorMessage is readable and carries the saved note', () => {
    expect(networkErrorMessage(NOTHING_SAVED_NOTE)).toMatch(/Couldn't reach the server/);
    expect(networkErrorMessage(NOTHING_SAVED_NOTE)).toContain(NOTHING_SAVED_NOTE);
  });
});
