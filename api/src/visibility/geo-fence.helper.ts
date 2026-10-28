/**
 * geo-fence.helper.ts — pure, dependency-free per-photo geo-fence math for the
 * Visibility (POSM) feature (per-photo geotag). NO NestJS / Prisma imports so it is
 * unit-testable and safe to import from services, the report/review layer (Stream D),
 * and specs alike.
 *
 * A "photo fence" evaluates a single photo's embedded shutter-time GPS fix against the
 * outlet's reference location:
 *   - 'inside'       → a valid fix within `radiusMeters` of the reference;
 *   - 'outside'      → a valid fix beyond `radiusMeters` (the anti-fraud hard-block);
 *   - 'unverifiable' → no reference geo, or the photo has no / an invalid fix
 *                      (flag-for-approver, never a hard-block).
 *
 * Design: docs/plans/PER-PHOTO-GEOTAG-PLAN.md (per-photo geo-fence).
 */

import type { GpsCapture } from './visibility-types';

/**
 * Outlet-master geo-fence radius, in metres. Shared by BOTH gated flows (KYC enrollment +
 * visibility capture) so the "within the outlet" rule is defined exactly once. Currently a
 * platform-wide constant; it can be promoted to per-tenant config later (e.g. read off
 * `clients.features`/`visibilityConfig`) without touching the call sites that reuse it.
 */
export const OUTLET_MASTER_GEOFENCE_RADIUS_M = 200;

/**
 * Timed high-accuracy field-acquisition knobs (BOTH tunable). The capture FEs, on a
 * geo-fence tenant, run a timed `watchPosition` and keep the best (lowest-accuracy) fix:
 *   • GEO_ACQUIRE_MAX_MS              — hard CAP on how long to wait for a fix before
 *     resolving with the best seen (or null if none).
 *   • GEO_ACQUIRE_TARGET_ACCURACY_M  — EARLY-ACCEPT threshold: the moment a fix at or under
 *     this accuracy (metres) arrives, stop waiting and use it.
 * Exported here (the single source of truth alongside the fence radius) so the values are
 * documented in one place; the FE mirrors them in `platform/src/lib/geo-acquire.ts` (the FE
 * cannot import from the api package). Deoleo / non-gated tenants never run the timed path.
 */
export const GEO_ACQUIRE_MAX_MS = 5000;
export const GEO_ACQUIRE_TARGET_ACCURACY_M = 50;

/** Outcome of a single fence-required photo's location check. */
export type PhotoFenceStatus = 'inside' | 'outside' | 'unverifiable';

/**
 * Great-circle distance in metres between two lat/lng points (haversine).
 * Pure — identical math to the capture service's module-local haversine.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000; // Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A usable geo fix: a non-null object whose lat/lng are finite AND within valid Earth
 * ranges (lat −90..90, lng −180..180). Garbage / out-of-range / absent fixes are NOT
 * valid — a fence-required photo with such a fix is treated as 'unverifiable'.
 */
export function isValidGeo(g: GpsCapture | null | undefined): g is GpsCapture {
  if (!g || typeof g !== 'object') return false;
  const { lat, lng } = g;
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * A USABLE outlet-master reference point: present, in valid Earth ranges, and not the
 * null-island sentinel (0,0) — the common bulk-upload default for "coords missing". An
 * unusable reference must fall to 'unverifiable' (allow + flag), NEVER a spurious hard-block:
 * a 0/0 or out-of-range master coord would otherwise compute a huge distance and wrongly
 * block a rep standing at the real outlet. Used only on the gated outlet-master fence path,
 * so non-gated tenants (Deoleo) are unaffected.
 */
export function isUsableReference(
  ref: { lat: number; lng: number } | null | undefined,
): ref is { lat: number; lng: number } {
  return !!ref && isValidGeo(ref) && !(ref.lat === 0 && ref.lng === 0);
}

/**
 * Evaluate one fence-required photo's fix against the outlet reference geo.
 *
 * reference null OR geo absent/invalid → 'unverifiable' (flag, never block);
 * else 'inside' when haversine distance ≤ `radiusMeters`, otherwise 'outside'.
 */
export function evaluatePhotoFence(
  geo: GpsCapture | null | undefined,
  reference: { lat: number; lng: number } | null,
  radiusMeters: number,
): PhotoFenceStatus {
  if (!reference || !isValidGeo(geo)) return 'unverifiable';
  const distance = haversineMeters({ lat: geo.lat, lng: geo.lng }, reference);
  return distance <= radiusMeters ? 'inside' : 'outside';
}
