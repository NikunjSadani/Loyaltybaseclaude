/**
 * SessionExpiryGuard — refresh outcome handling (B3, 2026-11-19).
 * A TRANSIENT refresh failure (network / 5xx) must NOT bounce a possibly-alive session to login;
 * a DEFINITE refusal still does. (The guard installs its fetch patch once per module instance, so
 * each case re-imports a fresh module.)
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

const refreshSession = vi.fn();
vi.mock('@/lib/auth-actions', () => ({ refreshSession: () => refreshSession() }));

const assign = vi.fn();
let realFetch: typeof window.fetch;

beforeEach(() => {
  vi.resetModules();
  refreshSession.mockReset();
  assign.mockReset();
  realFetch = window.fetch;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname: '/admin/users', assign },
  });
});
afterEach(() => {
  cleanup();
  window.fetch = realFetch;
});

async function mountWithBackend(statuses: number[]) {
  const backend = vi.fn();
  for (const s of statuses) backend.mockResolvedValueOnce(new Response(null, { status: s }));
  window.fetch = backend as unknown as typeof window.fetch;
  const { default: SessionExpiryGuard } = await import('@/components/auth/SessionExpiryGuard');
  render(React.createElement(SessionExpiryGuard));
  return backend;
}

describe('SessionExpiryGuard — refresh outcomes', () => {
  it('TRANSIENT refresh failure → returns the original 401, NO login redirect, no retry', async () => {
    refreshSession.mockResolvedValue({ ok: false, transient: true });
    const backend = await mountWithBackend([401]);

    const res = await window.fetch('/api/wallet/me');

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('DEAD refresh → redirects to /auth/login?expired=1', async () => {
    refreshSession.mockResolvedValue({ ok: false });
    await mountWithBackend([401]);

    await window.fetch('/api/wallet/me');

    expect(assign).toHaveBeenCalledWith('/auth/login?expired=1');
  });

  it('refresh OK → retries the original request once and returns the retry', async () => {
    refreshSession.mockResolvedValue({ ok: true });
    const backend = await mountWithBackend([401, 200]);

    const res = await window.fetch('/api/wallet/me');

    expect(res.status).toBe(200);
    expect(backend).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });
});
