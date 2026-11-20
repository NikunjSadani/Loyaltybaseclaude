/**
 * POST /auth/session-refresh — the guard's refresh endpoint maps refreshSession's typed result to a
 * real HTTP status, and refuses requests that are not same-origin guard calls (CSRF).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const refreshSession = vi.fn();
vi.mock('@/lib/auth-actions', () => ({ refreshSession: () => refreshSession() }));

import { POST } from '@/app/auth/session-refresh/route';

const req = (headers: Record<string, string> = { 'x-session-refresh': '1' }) =>
  new NextRequest('https://bajaj.gifsy.in/auth/session-refresh', { method: 'POST', headers });

beforeEach(() => {
  refreshSession.mockReset(); // braces: a function RETURNED from beforeEach would run as a teardown hook
});

describe('POST /auth/session-refresh', () => {
  it('ok → 200 { ok:true }, no-store', async () => {
    refreshSession.mockResolvedValue({ ok: true });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('definitely dead → 401', async () => {
    refreshSession.mockResolvedValue({ ok: false });
    expect((await POST(req())).status).toBe(401);
  });

  it('transient → 503 with Retry-After', async () => {
    refreshSession.mockResolvedValue({ ok: false, transient: true });
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('the action throwing → 503 (never a 401 / logout)', async () => {
    refreshSession.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect((await POST(req())).status).toBe(503);
  });

  it('CSRF: missing x-session-refresh header → 400, refreshSession NOT called', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('CSRF: a browser-reported cross-site request → 403, refreshSession NOT called', async () => {
    const res = await POST(req({ 'x-session-refresh': '1', 'sec-fetch-site': 'cross-site' }));
    expect(res.status).toBe(403);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('same-origin Sec-Fetch-Site is accepted', async () => {
    refreshSession.mockResolvedValue({ ok: true });
    expect((await POST(req({ 'x-session-refresh': '1', 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
  });
});
