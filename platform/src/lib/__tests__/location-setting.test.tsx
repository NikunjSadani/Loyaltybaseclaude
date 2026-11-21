/**
 * "Require location" on the phone while settings load / fail (LOCATION-GATE.md; DEFAULT ON since 2026-11-21): unknown
 * = ON, a failed load = ON + note, only a loaded explicit false turns the gate off; v2 cache. Plus the server-clock
 * skew read from the settings response's Date header (round-3 #3).
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth-client', () => ({ getStoredUser: () => ({ id: 'u-rep', name: 'R', role: 'SALES_ISR', phone: '' }) }));

import { useLocationSetting } from '../use-location-setting';
import { readLastKnownRequireLocation, writeLastKnownRequireLocation } from '../location-setting-cache';
import { useTenantFeatures } from '../tenant-features';

// lastKnown | gateEnabled | requireForForm | captureHold | settingsNote
function Probe({ req, loading, error }: { req: boolean; loading: boolean; error?: boolean }) {
  const s = useLocationSetting(req, loading, error);
  return <p data-testid="s">{`${String(s.lastKnown)}|${s.gateEnabled}|${s.requireForForm}|${s.captureHold}|${s.settingsNote}`}</p>;
}
const text = () => screen.getByTestId('s').textContent;

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.useRealTimers());

// DEFAULT ON since 2026-11-21 (audit #2): unknown = ON; only a LOADED explicit false turns the phone gate off.
describe('useLocationSetting', () => {
  it('unknown (first ever load) → gate ON + camera held while loading; a successful load is remembered', () => {
    const { rerender } = render(<Probe req loading />);
    expect(text()).toBe('null|true|true|true|false');
    rerender(<Probe req={true} loading={false} />);
    expect(text()).toBe('null|true|true|false|false');
    expect(readLastKnownRequireLocation()).toBe(true);
  });

  it('a LOADED explicit false → gate off, form not told requireLocation, remembered as false', () => {
    const { rerender } = render(<Probe req loading />);
    rerender(<Probe req={false} loading={false} />);
    expect(text()).toBe('null|false|false|false|false');
    expect(readLastKnownRequireLocation()).toBe(false);
  });

  it('settings load FAILED → gate ON, form told requireLocation, note shown — whatever the last-known value', () => {
    writeLastKnownRequireLocation(false);
    const { rerender } = render(<Probe req={false} loading />);
    rerender(<Probe req={false} loading={false} error />);
    expect(text()).toBe('false|true|true|false|true');
  });

  it('last-known FALSE (a fresh v2 value) while loading → gate not run yet, but the FORM is still told requireLocation', () => {
    writeLastKnownRequireLocation(false);
    render(<Probe req={false} loading />);
    expect(text()).toBe('false|false|true|false|false');
  });

  it('a pre-deploy cached "0" under the OLD key is ignored (unknown → ON)', () => {
    window.localStorage.setItem(`lg:requireLocation:u-rep:${window.location.host}`, '0');
    render(<Probe req loading />);
    expect(text()).toBe('null|true|true|true|false');
  });

  it('camera hold is released after at most 5 s', async () => {
    writeLastKnownRequireLocation(true);
    vi.useFakeTimers();
    render(<Probe req loading />);
    expect(text()).toBe('true|true|true|true|false');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toBe('true|true|true|false|false');
  });

  it('storage that throws → unknown (= ON), never crashes', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      render(<Probe req loading />);
      expect(text()).toBe('null|true|true|true|false');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('useTenantFeatures — server clock skew', () => {
  function F({ clock = true }: { clock?: boolean }) {
    const s = useTenantFeatures('/api/sales/me', { clock });
    return <p data-testid="f">{s.loading ? 'loading' : `${s.serverSkewMs == null ? 'null' : Math.round(s.serverSkewMs / 3_600_000)}|${String(!!s.error)}`}</p>;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('ITEM 5: reads the Date header PASSIVELY off the original request (no cache option, no extra request)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'date' ? new Date(Date.now() - 48 * 3_600_000).toUTCString() : null) },
      json: () => Promise.resolve({ data: { features: {} } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<F />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('48|false'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty('cache'); // byte-identical original request
  });

  it('ITEM 5: refetchClock is the no-store confirmation; a failure resolves null and clears the skew', async () => {
    let api: ReturnType<typeof useTenantFeatures> | null = null;
    function G() {
      api = useTenantFeatures('/api/sales/me', { clock: true });
      return <p data-testid="g">{api.loading ? 'loading' : String(api.serverSkewMs == null ? 'null' : Math.round(api.serverSkewMs / 3_600_000))}</p>;
    }
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'date' ? new Date(Date.now() - 48 * 3_600_000).toUTCString() : null) },
      json: () => Promise.resolve({ data: { features: {} } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<G />);
    await waitFor(() => expect(screen.getByTestId('g').textContent).toBe('48'));
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    let out: number | null | undefined;
    await act(async () => { out = await api!.refetchClock!(); });
    expect(out).toBeNull();
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
    expect(screen.getByTestId('g').textContent).toBe('null');
  });

  it('ROUND 4 #5: a cached response (Age header) is corrected — Date 30 h old with Age 30 h → ~0 skew', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'date' ? new Date(Date.now() - 30 * 3_600_000).toUTCString() : h.toLowerCase() === 'age' ? String(30 * 3600) : null,
      },
      json: () => Promise.resolve({ data: { features: {} } }),
    }));
    render(<F />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('0|false'));
  });

  it('callers without the clock option are unchanged (no cache option, no skew)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => new Date(Date.now() - 48 * 3_600_000).toUTCString() },
      json: () => Promise.resolve({ data: { features: {} } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<F clock={false} />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('null|false'));
    expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty('cache');
  });

  it('a failed settings load → error true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, json: () => Promise.resolve({}) }));
    render(<F />);
    await waitFor(() => expect(screen.getByTestId('f').textContent).toBe('null|true'));
  });
});
