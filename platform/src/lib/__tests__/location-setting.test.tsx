/**
 * Last-known "Require location" (LOCATION-GATE.md, round-3 #4/#5): camera hold only for last-known-TRUE reps, at most
 * 5 s; settings-failure note only for last-known-TRUE reps; unknown / false (Deoleo) → neither. Plus the server-clock
 * skew read from the settings response's Date header (round-3 #3).
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth-client', () => ({ getStoredUser: () => ({ id: 'u-rep', name: 'R', role: 'SALES_ISR', phone: '' }) }));

import { useLocationSetting } from '../use-location-setting';
import { readLastKnownRequireLocation, writeLastKnownRequireLocation } from '../location-setting-cache';
import { useTenantFeatures } from '../tenant-features';

function Probe({ req, loading, error }: { req: boolean; loading: boolean; error?: boolean }) {
  const s = useLocationSetting(req, loading, error);
  return <p data-testid="s">{`${String(s.lastKnown)}|${s.captureHold}|${s.settingsNote}`}</p>;
}
const text = () => screen.getByTestId('s').textContent;

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('useLocationSetting', () => {
  it('unknown (first ever load) → no hold, no note; a successful load is remembered', () => {
    const { rerender } = render(<Probe req loading />);
    expect(text()).toBe('null|false|false');
    rerender(<Probe req={true} loading={false} />);
    expect(readLastKnownRequireLocation()).toBe(true);
  });

  it('last-known FALSE (Deoleo) → never held, never a note — even on a settings failure', () => {
    writeLastKnownRequireLocation(false);
    const { rerender } = render(<Probe req={false} loading />);
    expect(text()).toBe('false|false|false');
    rerender(<Probe req={false} loading={false} error />);
    expect(text()).toBe('false|false|false');
  });

  it('last-known TRUE → held while loading, released after at most 5 s; note on a failure', async () => {
    writeLastKnownRequireLocation(true);
    vi.useFakeTimers();
    const { rerender } = render(<Probe req={false} loading />);
    expect(text()).toBe('true|true|false');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toBe('true|false|false');
    rerender(<Probe req={false} loading={false} error />);
    expect(text()).toBe('true|false|true');
  });

  it('storage that throws → unknown, never crashes', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      render(<Probe req loading />);
      expect(text()).toBe('null|false|false');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('useTenantFeatures — server clock skew', () => {
  function F() {
    const s = useTenantFeatures('/api/sales/me');
    return <p data-testid="f">{s.loading ? 'loading' : `${s.serverSkewMs == null ? 'null' : Math.round(s.serverSkewMs / 3_600_000)}|${String(!!s.error)}`}</p>;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('reads the Date header (phone 48 h ahead → ~48 h skew); a failure sets error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'date' ? new Date(Date.now() - 48 * 3_600_000).toUTCString() : null) },
      json: () => Promise.resolve({ data: { features: {} } }),
    }));
    render(<F />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('48|false'));
  });

  it('a failed settings load → error true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, json: () => Promise.resolve({}) }));
    render(<F />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('null|true'));
  });
});
