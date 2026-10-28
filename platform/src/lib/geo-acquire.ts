/**
 * geo-acquire.ts — timed high-accuracy GPS acquisition for the capture FEs, with PRE-WARMING.
 *
 * `startPreciseWatch()` begins a high-accuracy `watchPosition` EARLY (e.g. when the rep reaches
 * the board-photo step / when the capture sheet opens) and keeps the BEST (lowest-`accuracy`)
 * fix updating in the background. At capture time the caller awaits `handle.acquire()`:
 *   • if a fix at or under `GEO_ACQUIRE_TARGET_ACCURACY_M` is ALREADY in hand → use it at once;
 *   • otherwise wait up to `GEO_ACQUIRE_MAX_MS` MORE for a good one, then the best-so-far (null if none).
 * `lockMs` on the returned fix is measured from the WATCH START (the pre-warm start), so it
 * reflects true time-to-lock including the head start. `handle.stop()` clears the watch (call on
 * unmount / after use) — idempotent, no leaks, no hanging.
 *
 * `acquirePreciseFix()` is the one-shot convenience for call sites that do NOT pre-warm: it
 * starts a watch, acquires, and stops — identical timing semantics, no head start.
 *
 * GATING: used ONLY on geo-fence tenants (`features.outletMasterGeo`). Non-gated tenants
 * (Deoleo) keep their exact existing single `getCurrentPosition` call → byte-identical capture.
 *
 * The two knobs mirror the backend `api/src/visibility/geo-fence.helper.ts` constants of the
 * same name (the FE cannot import from the api package). Keep them in sync if tuned.
 */

/** Hard cap (ms) on how long an `acquire()` waits for a fix before resolving with the best seen. */
export const GEO_ACQUIRE_MAX_MS = 5000;
/** Early-accept accuracy (metres): the first fix at or under this ends the wait immediately. */
export const GEO_ACQUIRE_TARGET_ACCURACY_M = 50;
/**
 * Freshness window (ms) for a pre-warmed best fix. A "best" (lowest-accuracy) fix older than this
 * is AGED OUT, so a rep who moved after pre-warm started (e.g. got a precise fix 400 m away at an
 * earlier step, then walked to the outlet) is scored on a RECENT fix — not the stale precise one,
 * which would wrongly compute a large distance and FALSE-BLOCK a rep standing at the outlet.
 */
export const GEO_ACQUIRE_FRESHNESS_MS = 10000;

export interface PreciseFix {
  lat: number;
  lng: number;
  /** Reported accuracy of this fix, in metres (rounded). */
  accuracy: number;
  /** Milliseconds from the WATCH START to when this fix arrived (lock time). */
  lockMs: number;
}

export interface AcquirePreciseFixOptions {
  /** Override the per-acquire hard cap (ms). Defaults to GEO_ACQUIRE_MAX_MS. */
  maxMs?: number;
  /** Override the early-accept accuracy (metres). Defaults to GEO_ACQUIRE_TARGET_ACCURACY_M. */
  targetAccuracyM?: number;
  /** Override the best-fix freshness window (ms). Defaults to GEO_ACQUIRE_FRESHNESS_MS. */
  freshnessMs?: number;
}

/** A live background GPS watch that keeps the best fix and can be awaited + stopped. */
export interface PreciseWatchHandle {
  /** The best (lowest-accuracy) fix seen so far, or null. */
  getBest(): PreciseFix | null;
  /**
   * Resolve a fix to USE now (never rejects):
   *   • a fix ≤ targetAccuracyM already in hand → that fix immediately;
   *   • else wait up to maxMs MORE for a good fix, then the best-so-far (or null).
   */
  acquire(): Promise<PreciseFix | null>;
  /** Stop + clear the watch (idempotent). Resolves any pending acquire with the best seen. */
  stop(): void;
}

/**
 * Begin a high-accuracy background watch. Keeps the best fix; `acquire()` consumes it with the
 * early-accept / timed-wait semantics above. Never throws.
 */
export function startPreciseWatch(opts: AcquirePreciseFixOptions = {}): PreciseWatchHandle {
  const maxMs = opts.maxMs ?? GEO_ACQUIRE_MAX_MS;
  const targetAccuracyM = opts.targetAccuracyM ?? GEO_ACQUIRE_TARGET_ACCURACY_M;
  const freshnessMs = opts.freshnessMs ?? GEO_ACQUIRE_FRESHNESS_MS;

  const start = Date.now();
  let best: PreciseFix | null = null;
  let bestAt = 0; // wall-clock (ms) when `best` was recorded — drives the freshness window.
  let watchId: number | null = null;
  let stopped = false;
  let hadError = false;
  // At most one in-flight acquire waiter (capture is user-initiated + button-disabled while busy).
  let waiter: { resolve: (f: PreciseFix | null) => void; timer: ReturnType<typeof setTimeout> | null } | null = null;

  const noGeo = typeof navigator === 'undefined' || !navigator.geolocation;

  const settleWaiter = (fix: PreciseFix | null) => {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    if (w.timer != null) clearTimeout(w.timer);
    w.resolve(fix);
  };

  /** True when `best` is set, good enough, AND still within the freshness window. */
  const freshGood = () =>
    best !== null && best.accuracy <= targetAccuracyM && Date.now() - bestAt <= freshnessMs;

  const onPos = (pos: GeolocationPosition) => {
    const now = Date.now();
    const candidate: PreciseFix = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Math.round(pos.coords.accuracy),
      lockMs: now - start,
    };
    // Keep the best (lowest-accuracy) fix — but RECENCY-AWARE: if the current best has aged out of
    // the freshness window (the rep may have moved since), replace it with this fresh fix even if
    // less accurate; otherwise keep the most accurate fix WITHIN the window. This prevents a stale
    // precise fix from an earlier spot from wrongly scoring the rep as far from the outlet.
    if (best === null || now - bestAt > freshnessMs || candidate.accuracy < best.accuracy) {
      best = candidate;
      bestAt = now;
    }
    // Early-accept: a good-enough, still-fresh fix ends a pending acquire immediately.
    if (waiter && freshGood()) settleWaiter(best);
  };

  const onError = () => {
    hadError = true;
    // A pending acquire resolves with the best seen so far (never hang on an error).
    settleWaiter(best);
  };

  if (!noGeo) {
    try {
      watchId = navigator.geolocation.watchPosition(onPos, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: maxMs,
      });
    } catch {
      watchId = null;
      hadError = true;
    }
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(watchId);
      } catch {
        /* best-effort cleanup */
      }
    }
    settleWaiter(best);
  };

  const acquire = (): Promise<PreciseFix | null> => {
    // A good, still-fresh fix is already in hand → use it immediately (no wait).
    if (freshGood()) return Promise.resolve(best);
    // Stopped, unsupported, or already errored with nothing → resolve the best (possibly null) now.
    if (stopped || (best === null && (noGeo || hadError))) return Promise.resolve(best);
    // Otherwise wait up to maxMs MORE for a good fix; else the best-so-far at the cap.
    return new Promise<PreciseFix | null>((resolve) => {
      // A second concurrent acquire shouldn't strand the first — settle it with the best seen.
      settleWaiter(best);
      const timer = setTimeout(() => {
        waiter = null;
        resolve(best);
      }, maxMs);
      waiter = { resolve, timer };
    });
  };

  return { getBest: () => best, acquire, stop };
}

/**
 * One-shot acquire for call sites that do not pre-warm: start a watch, acquire, stop.
 * Resolves with the best fix (or null). Never rejects, never hangs.
 */
export function acquirePreciseFix(
  opts: AcquirePreciseFixOptions = {},
): Promise<PreciseFix | null> {
  const handle = startPreciseWatch(opts);
  return handle.acquire().then((fix) => {
    handle.stop();
    return fix;
  });
}
