/**
 * Silent refresh must treat a 429 as "retry later", not "session dead" (2026-11-10).
 *
 * refreshTokensViaBackend returns null on ANY failure, and both callers (the edge proxy on page
 * navigation, the refreshSession server action behind SessionExpiryGuard) bounce the user to
 * /auth/login on null. A throttler 429 is rejected BEFORE the backend touches the refresh token
 * (the guard runs first), so the single-use token is still valid → retrying it is safe.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { refreshTokensViaBackend } from '@/lib/auth-refresh';

const ok = { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ data: { accessToken: 'a2', refreshToken: 'r2' } }) };
const cancels: Array<ReturnType<typeof vi.fn>> = [];
const tooMany = (retryAfter?: string) => ({
  ok: false,
  status: 429,
  body: (() => { const cancel = vi.fn().mockResolvedValue(undefined); cancels.push(cancel); return { cancel }; })(),
  headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
  json: () => Promise.resolve({ success: false, error: 'ThrottlerException: Too Many Requests' }),
});
const unauthorized = { ok: false, status: 401, headers: new Headers(), json: () => Promise.resolve({ success: false, error: 'Invalid refresh token' }) };

describe('refreshTokensViaBackend — 429 handling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a 429 followed by success → retries with the SAME refresh token and returns the new pair', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) expect(JSON.parse(call[1].body)).toEqual({ refreshToken: 'r1' });
  });

  it('persistent 429 → bounded retries (3 attempts total), then null (cookies left intact by callers)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tooMany('1'));
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours a short Retry-After but caps a long one (never stalls a page navigation)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany('3600')).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.advanceTimersByTimeAsync(2_000); // cap
    await expect(p).resolves.toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases each unread 429 body (cancel) before waiting -- no leaked sockets', async () => {
    cancels.length = 0;
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(cancels).toHaveLength(2);
    for (const c of cancels) expect(c).toHaveBeenCalledTimes(1);
  });

  it('a body.cancel() that rejects does not break the retry', async () => {
    const bad = { ...tooMany(), body: { cancel: vi.fn().mockRejectedValue(new Error('locked')) } };
    const fetchMock = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('a non-429 failure (401 dead session) is NOT retried', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorized);
    vi.stubGlobal('fetch', fetchMock);
    const p = refreshTokensViaBackend('r1');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('success on the first try makes exactly one call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok);
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshTokensViaBackend('r1')).resolves.toEqual({ accessToken: 'a2', refreshToken: 'r2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
