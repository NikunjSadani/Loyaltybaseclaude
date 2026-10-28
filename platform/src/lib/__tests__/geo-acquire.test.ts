/**
 * geo-acquire.test.ts — the timed high-accuracy GPS acquire used by the capture FEs on
 * geo-fence tenants (Bajaj).
 *
 * GA1: early-accept — the first fix at/under the target accuracy resolves immediately + clears the watch
 * GA2: keeps the BEST fix, then resolves it when the cap elapses (no early-accept fix arrived)
 * GA3: no geolocation support → resolves null (never hangs)
 * GA4: a geolocation error with NO prior fix → resolves null
 * GA5: a geolocation error AFTER a fix → resolves the best fix seen
 * GA6: measures lockMs and always clears the watch exactly once
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquirePreciseFix,
  startPreciseWatch,
  GEO_ACQUIRE_MAX_MS,
  GEO_ACQUIRE_TARGET_ACCURACY_M,
  GEO_ACQUIRE_FRESHNESS_MS,
} from '../geo-acquire';

type SuccessCb = (p: GeolocationPosition) => void;
type ErrorCb = (e: GeolocationPositionError) => void;

function makePos(accuracy: number, lat = 12.9, lng = 77.5): GeolocationPosition {
  return {
    coords: {
      latitude: lat, longitude: lng, accuracy,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null,
    },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

const realGeo = navigator.geolocation;

describe('acquirePreciseFix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
  });

  function installWatch(impl: (success: SuccessCb, error: ErrorCb) => number) {
    const clearWatch = vi.fn();
    const watchPosition = vi.fn((success: SuccessCb, error: ErrorCb) => impl(success, error));
    Object.defineProperty(navigator, 'geolocation', {
      value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
      configurable: true,
    });
    return { watchPosition, clearWatch };
  }

  it('GA1: early-accepts the first fix at/under the target accuracy and clears the watch', async () => {
    const { clearWatch } = installWatch((success) => {
      // A good fix arrives immediately.
      success(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M - 10));
      return 42;
    });
    const fix = await acquirePreciseFix();
    expect(fix).not.toBeNull();
    expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M - 10);
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it('GA2: keeps the best fix and resolves it at the time cap (no early-accept)', async () => {
    let cb: SuccessCb = () => {};
    const { clearWatch } = installWatch((success) => { cb = success; return 7; });
    const p = acquirePreciseFix();
    // Two imprecise fixes (both worse than the target) — the lower accuracy wins.
    cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 70)); // 120
    cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 30)); // 80 (best)
    // Nothing resolved yet (no early-accept). Advance to the cap.
    vi.advanceTimersByTime(GEO_ACQUIRE_MAX_MS);
    const fix = await p;
    expect(fix).not.toBeNull();
    expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 30);
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it('GA3: resolves null when geolocation is unsupported (never hangs)', async () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    await expect(acquirePreciseFix()).resolves.toBeNull();
  });

  it('GA4: a geolocation error with no prior fix → null', async () => {
    installWatch((_success, error) => {
      error({ code: 1, message: 'denied' } as GeolocationPositionError);
      return 1;
    });
    await expect(acquirePreciseFix()).resolves.toBeNull();
  });

  it('GA5: a geolocation error AFTER a fix → resolves the best fix seen', async () => {
    let success: SuccessCb = () => {};
    let error: ErrorCb = () => {};
    installWatch((s, e) => { success = s; error = e; return 9; });
    const p = acquirePreciseFix();
    success(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 40)); // imprecise, kept as best
    error({ code: 2, message: 'position unavailable' } as GeolocationPositionError);
    const fix = await p;
    expect(fix).not.toBeNull();
    expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 40);
  });

  it('GA6: reports a numeric lockMs on the resolved fix', async () => {
    let cb: SuccessCb = () => {};
    installWatch((success) => { cb = success; return 3; });
    const p = acquirePreciseFix();
    vi.advanceTimersByTime(1200);
    cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M - 5)); // good → early accept
    const fix = await p;
    expect(fix).not.toBeNull();
    expect(typeof fix!.lockMs).toBe('number');
    expect(fix!.lockMs).toBeGreaterThanOrEqual(0);
  });

  // ── Pre-warm (startPreciseWatch) ────────────────────────────────────────────────────
  describe('startPreciseWatch (pre-warm)', () => {
    it('PW1: a good fix already in hand → acquire() resolves immediately, lockMs from watch start', async () => {
      let cb: SuccessCb = () => {};
      const { clearWatch } = installWatch((success) => { cb = success; return 11; });
      const handle = startPreciseWatch();
      // Pre-warm phase: time passes, then a good fix lands BEFORE the rep captures.
      vi.advanceTimersByTime(900);
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M - 20));
      // Capture: a good fix is already in hand → immediate, no timer advance needed.
      const fix = await handle.acquire();
      expect(fix).not.toBeNull();
      expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M - 20);
      expect(fix!.lockMs).toBe(900); // measured from WATCH start (the head start)
      handle.stop();
      expect(clearWatch).toHaveBeenCalledWith(11);
    });

    it('PW2: only imprecise fixes so far → acquire() waits for a later good fix (early-accept)', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 12; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 60)); // imprecise during pre-warm
      const p = handle.acquire(); // no good fix yet → waits
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M - 5)); // good fix arrives → early-accept
      const fix = await p;
      expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M - 5);
      handle.stop();
    });

    it('PW3: stop() clears the watch and resolves a pending acquire with the best seen', async () => {
      let cb: SuccessCb = () => {};
      const { clearWatch } = installWatch((success) => { cb = success; return 13; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 30)); // imprecise best
      const p = handle.acquire(); // waits (no good fix)
      handle.stop(); // unmount → settle with best, clear watch
      const fix = await p;
      expect(fix!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 30);
      expect(clearWatch).toHaveBeenCalledWith(13);
    });

    it('PW4: a STALE precise fix is aged out — acquire() uses the RECENT fix after the rep moved', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 14; });
      const handle = startPreciseWatch();
      // A very precise fix at the pre-warm spot (e.g. 400 m away, before walking to the outlet).
      cb(makePos(10, 12.9, 77.5));
      // The rep lingers / moves past the freshness window, then a fresh (less precise) at-outlet fix lands.
      vi.advanceTimersByTime(GEO_ACQUIRE_FRESHNESS_MS + 1000);
      cb(makePos(40, 13.0, 77.6));
      const fix = await handle.acquire();
      // The stale precise fix (acc 10 @ the old spot) is NOT reused; the recent fix (acc 40 @ outlet) wins.
      expect(fix!.accuracy).toBe(40);
      expect(fix!.lat).toBe(13.0);
      expect(fix!.lng).toBe(77.6);
      handle.stop();
    });
  });
});
