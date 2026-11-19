/**
 * Last-known "Require location" setting per signed-in user + tenant host (LOCATION-GATE.md, round-3 #4/#5).
 *
 * Lets the phone decide — BEFORE the programme settings arrive — whether to briefly hold the visibility camera, and
 * whether a settings-load FAILURE deserves a "location may be required" note. A user whose last-known value is false
 * (every Deoleo rep after their first load) never sees either. Browser storage only (a per-viewer convenience); every
 * access is wrapped — private mode / blocked storage simply means "unknown".
 */
import { getStoredUser } from './auth-client';

const PREFIX = 'lg:requireLocation:';

function key(): string | null {
  try {
    const u = getStoredUser();
    if (!u?.id || typeof window === 'undefined') return null;
    return `${PREFIX}${u.id}:${window.location.host}`;
  } catch {
    return null;
  }
}

/** true / false = last value seen for this user + tenant; null = never seen (or storage unavailable). */
export function readLastKnownRequireLocation(): boolean | null {
  const k = key();
  if (!k) return null;
  try {
    const v = window.localStorage.getItem(k);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeLastKnownRequireLocation(value: boolean): void {
  const k = key();
  if (!k) return;
  try {
    window.localStorage.setItem(k, value ? '1' : '0');
  } catch {
    /* storage unavailable — stays "unknown" */
  }
}

/** Longest the camera is ever held while the settings load (the server enforces the rule regardless). */
export const CAPTURE_HOLD_MAX_MS = 5_000;
