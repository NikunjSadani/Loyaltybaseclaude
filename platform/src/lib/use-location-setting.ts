'use client';

/**
 * useLocationSetting — the phone's view of the "Require location" setting while the programme settings load / fail
 * (LOCATION-GATE.md). DEFAULT ON since 2026-11-21: the phone treats the setting as ON unless it was LOADED as an
 * explicit `false` (emergency off). Pure on-device state (browser storage + one timer); no network.
 *
 *   • gateEnabled     — what to pass to useLocationGate. Loaded OK → the loaded value. Load FAILED → ON (the guide
 *                       shows up front; a rep never fills the whole KYC only to hit the server refusal). Still loading →
 *                       ON unless the last-known value (v2 cache, written only from a successful load) is `false`.
 *   • requireForForm  — what the visibility form is told (CameraField: "a tagged photo without a fix is not kept").
 *                       `false` ONLY when the loaded setting is explicitly off — never while loading / after a failure.
 *   • captureHold     — hold the visibility camera while settings load (≤ CAPTURE_HOLD_MAX_MS) unless last-known is
 *                       `false`.
 *   • settingsNote    — "location may be required" on ANY settings-load failure.
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
    if (!loading || lastKnown === false) return;
    const t = setTimeout(() => setHoldExpired(true), CAPTURE_HOLD_MAX_MS);
    return () => clearTimeout(t);
  }, [loading, lastKnown]);

  const loadedOff = !loading && !error && requireLocation === false;
  return {
    lastKnown,
    gateEnabled: loading ? lastKnown !== false : !loadedOff,
    requireForForm: !loadedOff,
    captureHold: loading && lastKnown !== false && !holdExpired,
    settingsNote: !loading && !!error,
  };
}
