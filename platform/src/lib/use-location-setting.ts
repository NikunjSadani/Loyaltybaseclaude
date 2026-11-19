'use client';

/**
 * useLocationSetting — the last-known "Require location" behaviour while the programme settings load / fail
 * (LOCATION-GATE.md, round-3 #4/#5). Pure on-device state (browser storage + one timer); no network.
 *
 *   • captureHold    — hold the visibility camera ONLY when the last-known value is TRUE and the settings are still
 *                      loading, and never longer than CAPTURE_HOLD_MAX_MS. Unknown (first ever load) and false
 *                      (every Deoleo rep) → never held; the server enforces the rule anyway.
 *   • settingsNote   — show "location may be required" on a settings-load FAILURE, only when last-known is TRUE.
 *   • Writes the freshly loaded value back (successful loads only).
 */
import { useEffect, useState } from 'react';
import {
  CAPTURE_HOLD_MAX_MS,
  readLastKnownRequireLocation,
  writeLastKnownRequireLocation,
} from './location-setting-cache';

export const SETTINGS_FAILED_LOCATION_NOTE =
  "Couldn't load programme settings — location may be required; keep location on.";

export function useLocationSetting(requireLocation: boolean, loading: boolean, error?: boolean) {
  const [lastKnown] = useState<boolean | null>(() => readLastKnownRequireLocation());
  const [holdExpired, setHoldExpired] = useState(false);

  useEffect(() => {
    if (!loading && !error) writeLastKnownRequireLocation(requireLocation);
  }, [loading, error, requireLocation]);

  useEffect(() => {
    if (!loading || lastKnown !== true) return;
    const t = setTimeout(() => setHoldExpired(true), CAPTURE_HOLD_MAX_MS);
    return () => clearTimeout(t);
  }, [loading, lastKnown]);

  return {
    lastKnown,
    captureHold: loading && lastKnown === true && !holdExpired,
    settingsNote: !loading && !!error && lastKnown === true,
  };
}
