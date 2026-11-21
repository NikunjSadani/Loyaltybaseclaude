'use client';

/**
 * useLocationGate — the React side of the location gate (docs/plans/LOCATION-GATE.md).
 *
 *   enabled=false (the tenant's setting LOADED as an explicit false — console emergency off; DEFAULT is ON for every
 *     tenant since 2026-11-21, see useLocationSetting.gateEnabled) → status 'off', NOTHING runs:
 *     no permission query, no geolocation call, no listener. Byte-identical page.
 *   enabled=true → checks once on mount (status 'checking' → 'ok' | 'blocked'), re-checks when the browser reports
 *     the permission changed (Permissions API `change`, where available), and exposes:
 *       • recheck()                 — the "Test again" button. While BLOCKED it keeps the guide on screen and sets
 *                                     `testing` (the button shows "Checking…", focus stays on it);
 *       • recheck({ quiet: true })  — the submit-time check: keeps the page as-is (`submitChecking` drives a
 *                                     "Checking location…" label) and only switches to 'blocked' if location is no
 *                                     longer usable. Resolves the fix (truthy) when OK, else null.
 *   `blocking` is true while the page must show the gate panel instead of the flow.
 *
 * No timers, no network: geolocation and the Permissions API are on-device, so no X-Background tag is involved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkLocation,
  currentLocationPlatform,
  type LocationBlockReason,
  type LocationFix,
  type LocationPlatform,
  PHONE_CLOCK_MAX_SKEW_MS,
} from './location-gate';

export type LocationGateStatus = 'off' | 'checking' | 'ok' | 'blocked';

export interface LocationGateState {
  enabled: boolean;
  status: LocationGateStatus;
  reason: LocationBlockReason | null;
  platform: LocationPlatform;
  /** The fix that last passed the check. */
  fix: LocationFix | null;
  /** A "Test again" re-check is running while the guide stays on screen. */
  testing: boolean;
  /** A submit-time (quiet) check is running. */
  submitChecking: boolean;
  /** How many checks have finished while blocked — lets the panel announce "still blocked" each time. */
  attempts: number;
  /** True while the page must show the gate panel instead of the flow. */
  blocking: boolean;
  recheck: (opts?: { quiet?: boolean }) => Promise<LocationFix | null>;
}

export function useLocationGate(
  enabled: boolean,
  /**
   * Phone clock − server clock (ms) when known (from the settings response): > 24 h off → blocked with reason 'clock'.
   * `recheckClock` re-reads the server clock — "Test again" on the clock guide calls it and clears the block when the
   * clock is now right (round 4 #6).
   */
  opts: { serverSkewMs?: number | null; recheckClock?: () => Promise<number | null> } = {},
): LocationGateState {
  const clockWrong =
    typeof opts.serverSkewMs === 'number' && Number.isFinite(opts.serverSkewMs) && Math.abs(opts.serverSkewMs) > PHONE_CLOCK_MAX_SKEW_MS;
  const [status, setStatus] = useState<LocationGateStatus>(enabled ? 'checking' : 'off');
  const [reason, setReason] = useState<LocationBlockReason | null>(null);
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [platform, setPlatform] = useState<LocationPlatform>('desktop');
  const [testing, setTesting] = useState(false);
  const [submitChecking, setSubmitChecking] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const seq = useRef(0);
  // Bumped ONLY by a permission revoke: an in-flight check that started before a revoke returns null (round-3 #7).
  const revokes = useRef(0);
  const clockWrongRef = useRef(clockWrong);
  clockWrongRef.current = clockWrong;
  const recheckClockRef = useRef(opts.recheckClock);
  recheckClockRef.current = opts.recheckClock;
  const mounted = useRef(true);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const recheck = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}): Promise<LocationFix | null> => {
      if (!enabled) return null;
      if (clockWrongRef.current) {
        // The passive skew (from the normal settings response — possibly a cached Date) looks > 24 h. CONFIRM with one
        // no-store request before blocking (also what "Test again" does). Block only when the confirmation is skewed
        // too; a failed confirmation (null) never blocks on the clock — the server still refuses with its message.
        // A quiet (submit-time) check never fetches: by then the first check has already confirmed.
        const confirm = !quiet && recheckClockRef.current ? await recheckClockRef.current() : undefined;
        const stillWrong =
          confirm === undefined
            ? true
            : typeof confirm === 'number' && Number.isFinite(confirm) && Math.abs(confirm) > PHONE_CLOCK_MAX_SKEW_MS;
        if (stillWrong) {
          if (!mounted.current) return null;
          setTesting(false);
          setReason('clock');
          setStatus('blocked');
          setAttempts((n) => n + 1);
          return null;
        }
        clockWrongRef.current = false;
      }
      const mine = ++seq.current;
      const revokesAtStart = revokes.current;
      const wasBlocked = statusRef.current === 'blocked';
      if (quiet) setSubmitChecking(true);
      else if (wasBlocked) setTesting(true); // keep the guide (and focus) on screen while testing
      else setStatus('checking');
      const r = await checkLocation();
      if (!mounted.current) return r.ok ? r.fix : null;
      if (quiet) setSubmitChecking(false);
      // A permission REVOKE while this check ran → never a usable answer (audit #9).
      if (revokes.current !== revokesAtStart) return null;
      // Superseded by a newer check (e.g. a "granted" change event) → the newer check owns the state, but this check's
      // own valid result still answers its caller (round-3 #7: only a revoke cancels a submit check).
      if (mine !== seq.current) return r.ok ? r.fix : null;
      setTesting(false);
      if (r.ok) {
        setFix(r.fix);
        setReason(null);
        setStatus('ok');
        return r.fix;
      }
      setReason(r.reason);
      setStatus('blocked');
      setAttempts((n) => n + 1);
      return null;
    },
    [enabled, clockWrong],
  );

  // First check when the gate turns on (features loaded with the flag ON); reset when it turns off.
  useEffect(() => {
    if (!enabled) {
      seq.current++;
      setStatus('off');
      setReason(null);
      setTesting(false);
      return;
    }
    setPlatform(currentLocationPlatform());
    void recheck();
  }, [enabled, recheck]);

  // React to the rep changing the site permission while the page is open (where the browser reports it).
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let ps: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (!ps) return;
      if (ps.state === 'denied') {
        seq.current++;
        revokes.current++;
        setTesting(false);
        setReason('denied');
        setStatus('blocked');
        setAttempts((n) => n + 1);
      } else if (ps.state === 'granted') {
        void recheck();
      }
    };
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (cancelled || !s) return;
        ps = s;
        s.addEventListener?.('change', onChange);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ps?.removeEventListener?.('change', onChange);
    };
  }, [enabled, recheck]);

  return {
    enabled,
    status: enabled ? status : 'off',
    reason,
    platform,
    fix,
    testing,
    submitChecking,
    attempts,
    // While enabled, anything but a passed check blocks — incl. the one render before the first check starts.
    blocking: enabled && status !== 'ok',
    recheck,
  };
}
