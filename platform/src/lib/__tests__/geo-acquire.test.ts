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
 * SH1–SH5: concurrent acquires SHARE one in-flight acquisition (same fix, no early settle of the
 *          first caller, joiner waits ≤ remaining time, fresh acquisition after settle, 5 s cap)
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

    // ── Concurrent acquires SHARE one in-flight acquisition ─────────────────────────────
    it('SH1: two overlapping acquires (two photos seconds apart) both get the SAME good fix', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 21; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 60)); // imprecise only
      const settled: string[] = [];
      const p1 = handle.acquire().then((f) => { settled.push('p1'); return f; });
      vi.advanceTimersByTime(1500);
      const p2 = handle.acquire().then((f) => { settled.push('p2'); return f; });
      await Promise.resolve();
      await Promise.resolve();
      // SH5: the second call did NOT settle the first early.
      expect(settled).toEqual([]);
      vi.advanceTimersByTime(1000);
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M - 15, 13.1, 77.7)); // good fix → early-accept
      const [f1, f2] = await Promise.all([p1, p2]);
      expect(f1).not.toBeNull();
      expect(f1!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M - 15);
      expect(f2).toBe(f1); // the very same fix object
      expect(settled.sort()).toEqual(['p1', 'p2']);
      handle.stop();
    });

    it('SH2: photo + submit-time fix — the submit acquire joins and waits ≤ the photo\'s remaining time', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 22; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 30)); // imprecise best (80 m)
      let photo: unknown = 'pending';
      let submit: unknown = 'pending';
      handle.acquire().then((f) => { photo = f; });
      vi.advanceTimersByTime(3000);
      handle.acquire().then((f) => { submit = f; }); // submit tapped 3 s into the photo's wait
      // At the photo's cap (2 s more, NOT 5 s more) both resolve with the same best fix.
      await vi.advanceTimersByTimeAsync(GEO_ACQUIRE_MAX_MS - 3000 - 1);
      expect(photo).toBe('pending');
      expect(submit).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(photo).not.toBe('pending');
      expect((photo as { accuracy: number }).accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 30);
      expect(submit).toBe(photo);
      handle.stop();
    });

    it('SH3: an acquire AFTER the shared one settled starts a FRESH acquisition with a full cap', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 23; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 30));
      const p1 = handle.acquire();
      await vi.advanceTimersByTimeAsync(GEO_ACQUIRE_MAX_MS); // first settles at its cap
      expect((await p1)!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 30);
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 20)); // fresher, better, still imprecise
      let third: unknown = 'pending';
      const p3 = handle.acquire();
      expect(p3).not.toBe(p1);
      p3.then((f) => { third = f; });
      await vi.advanceTimersByTimeAsync(GEO_ACQUIRE_MAX_MS - 1);
      expect(third).toBe('pending'); // a full fresh 5 s window, not the old one
      await vi.advanceTimersByTimeAsync(1);
      expect((third as { accuracy: number }).accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 20);
      handle.stop();
    });

    it('SH4: the cap is still GEO_ACQUIRE_MAX_MS (5 s) per acquisition', async () => {
      expect(GEO_ACQUIRE_MAX_MS).toBe(5000);
      installWatch(() => 24); // no fixes at all
      const handle = startPreciseWatch();
      let res: unknown = 'pending';
      handle.acquire().then((f) => { res = f; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(res).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(res).toBeNull();
      handle.stop();
    });

    it('SH5: stop() while two callers share an acquisition resolves BOTH with the best seen', async () => {
      let cb: SuccessCb = () => {};
      installWatch((success) => { cb = success; return 25; });
      const handle = startPreciseWatch();
      cb(makePos(GEO_ACQUIRE_TARGET_ACCURACY_M + 10));
      const p1 = handle.acquire();
      const p2 = handle.acquire();
      handle.stop();
      const [f1, f2] = await Promise.all([p1, p2]);
      expect(f1!.accuracy).toBe(GEO_ACQUIRE_TARGET_ACCURACY_M + 10);
      expect(f2).toBe(f1);
    });
  });
});
