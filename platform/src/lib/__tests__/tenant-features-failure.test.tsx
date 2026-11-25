/// <reference types="vitest/globals" />
/**
 * useTenantFeatures — no silent fallback (owner rule): a FAILED read (network / 5xx) is reported as
 * failure 'unavailable' (callers must show it + offer retry), a 403 as 'forbidden' (quiet defaults).
 * Run: npx vitest run src/lib/__tests__/tenant-features-failure.test.tsx
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ authHeader: () => ({}) }));

import { useTenantFeatures, ADMIN_FEATURES_URL } from '../tenant-features';

let api: ReturnType<typeof useTenantFeatures>;
function Probe() {
  api = useTenantFeatures(ADMIN_FEATURES_URL);
  return <p data-testid="s">{`${api.loading}|${String(api.error)}|${String(api.failure)}|${api.features.salesImport}`}</p>;
}
const text = () => screen.getByTestId('s').textContent;
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('useTenantFeatures failure states', () => {
  it('success → no failure, real flags', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res({ success: true, data: { features: { salesImport: true } } }))));
    render(<Probe />);
    await waitFor(() => expect(text()).toBe('false|false|undefined|true'));
  });

  it('403 (role may not read the flags, e.g. MIS_USER) → forbidden, quiet defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res({ success: false, error: 'Access denied.' }, 403))));
    render(<Probe />);
    await waitFor(() => expect(text()).toBe('false|true|forbidden|false'));
  });

  it.each([
    ['HTTP 500', () => Promise.resolve(res({ success: false, error: 'boom' }, 500))],
    ['HTTP 502', () => Promise.resolve(new Response('Bad Gateway', { status: 502 }))],
    ['network error', () => Promise.reject(new Error('offline'))],
    ['unreadable 2xx body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])('%s → unavailable (never a quiet default); retry() recovers', async (_n, fail) => {
    const f = vi.fn().mockImplementationOnce(fail)
      .mockImplementation(() => Promise.resolve(res({ success: true, data: { features: { salesImport: true } } })));
    vi.stubGlobal('fetch', f);
    render(<Probe />);
    await waitFor(() => expect(text()).toBe('false|true|unavailable|false'));
    act(() => api.retry!());
    await waitFor(() => expect(text()).toBe('false|false|undefined|true'));
    expect(f).toHaveBeenCalledTimes(2);
  });
});
