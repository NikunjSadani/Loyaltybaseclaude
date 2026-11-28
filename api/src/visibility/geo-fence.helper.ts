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

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-photo fence POLICY — resolved once, used by BOTH the capture verdict
// (visibility-capture.service) and the reviewer's per-photo badges (visibility-review.service),
// so the two can never drift (prod finding 2026-11-19: badges used the KYC board ref + config radius
// on an outlet-master tenant while the verdict used the outlet master + 200 m).
// ─────────────────────────────────────────────────────────────────────────────

/** Reference + radius + whether the accuracy buffer applies. */
export interface PhotoFencePolicy {
  reference: { lat: number; lng: number } | null;
  radiusMeters: number;
  /** Outlet-master tenants: a fix whose own accuracy is worse than the radius is 'unverifiable', never in/out. */
  accuracyBuffer: boolean;
  /** Outlet-master tenants: a photo fix at 0,0 (the "no location" default) is 'unverifiable', never "outside". */
  nullIslandUnverifiable?: boolean;
}

/** The outlet-master reference (Prisma Decimal / number / numeric string), guarded by isUsableReference. */
export function outletMasterReference(o: { latitude?: unknown; longitude?: unknown }): { lat: number; lng: number } | null {
  if (o.latitude == null || o.longitude == null) return null;
  const ref = { lat: Number(o.latitude), lng: Number(o.longitude) };
  return isUsableReference(ref) ? ref : null;
}

/** The outlet-master (Bajaj) policy: outlet coordinates, forced 200 m, accuracy buffer ON. */
export function outletMasterFencePolicy(o: { latitude?: unknown; longitude?: unknown }): PhotoFencePolicy {
  return {
    reference: outletMasterReference(o),
    radiusMeters: OUTLET_MASTER_GEOFENCE_RADIUS_M,
    accuracyBuffer: true,
    nullIslandUnverifiable: true,
  };
}

/**
 * One photo's status under a policy: evaluatePhotoFence, then (buffer on) a valid fix whose reported accuracy is worse
 * than the radius is downgraded to 'unverifiable'. `accuracyTooLow` tells the caller the downgrade happened.
 */
export function classifyPhotoFence(
  geo: GpsCapture | null | undefined,
  policy: PhotoFencePolicy,
): { status: PhotoFenceStatus; accuracyTooLow: boolean } {
  if (policy.nullIslandUnverifiable && geo && geo.lat === 0 && geo.lng === 0) {
    return { status: 'unverifiable', accuracyTooLow: false };
  }
  const status = evaluatePhotoFence(geo, policy.reference, policy.radiusMeters);
  const accuracyTooLow =
    policy.accuracyBuffer &&
    status !== 'unverifiable' &&
    isValidGeo(geo) &&
    typeof geo.accuracy === 'number' &&
    Number.isFinite(geo.accuracy) &&
    geo.accuracy > policy.radiusMeters;
  return { status: accuracyTooLow ? 'unverifiable' : status, accuracyTooLow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rep-facing "distance from outlet" (owner 2026-11-28 — reps read the phone's ±accuracy as the distance from the
// outlet). The SAME number the fence decides on: classifyPhotoFence first (so a fix the fence cannot place — no
// reference, invalid / 0,0 fix, or accuracy worse than the radius on outlet-master tenants — has NO distance), then the
// haversine to the fence reference, rounded to the centimetre exactly as the capture verdict stores it.
// The FE mirrors ONLY the formatting (platform/src/lib/geo-distance.ts); the number itself always comes from here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The RAW fence distance (metres, unrounded) of one fix under a policy — the exact number the verdict compares with
 * the radius (evaluatePhotoFence: same haversine, same argument order) — or null when the fence cannot measure it.
 * Everything rep-facing (fenceDisplayMeters / formatDistance) is derived from THIS raw value, never from the 2-dp
 * stored one, so the shown number and the verdict can never disagree (raw 200.003 m at 200 m is outside → "201 m").
 */
export function fenceRawDistanceMeters(
  geo: GpsCapture | null | undefined,
  policy: PhotoFencePolicy,
): number | null {
  const { status, accuracyTooLow } = classifyPhotoFence(geo, policy);
  if (accuracyTooLow || status === 'unverifiable' || !policy.reference || !isValidGeo(geo)) return null;
  return haversineMeters({ lat: geo.lat, lng: geo.lng }, policy.reference);
}

/** The STORED fence distance (metres, 2 dp — the capture's informational distanceMeters column), or null. */
export function fenceDistanceMeters(
  geo: GpsCapture | null | undefined,
  policy: PhotoFencePolicy,
): number | null {
  const raw = fenceRawDistanceMeters(geo, policy);
  return raw == null ? null : Math.round(raw * 100) / 100;
}

const hasRadius = (r: number | null | undefined): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0;

/**
 * The WHOLE-METRE distance shown to the rep (and returned by the fence-distance endpoint — never cm precision).
 * Rounded so the shown number can never contradict the verdict at the radius:
 *   • OUTSIDE (raw > radius) → rounded UP, so it is always > the radius (200.3 m at 200 m → 201 m);
 *   • INSIDE (raw ≤ radius)  → normal rounding, capped at the radius (never a number > the radius for an inside photo).
 * No radius → normal rounding. Idempotent: an already-shown whole-metre value maps to itself.
 */
export function fenceDisplayMeters(rawM: number, radiusM?: number | null): number {
  if (!hasRadius(radiusM)) return Math.round(rawM);
  if (rawM > radiusM) return Math.ceil(rawM);
  return Math.min(Math.round(rawM), Math.floor(radiusM));
}

/** The radius in the same m / km wording ("200 m", "1.5 km"); km is rounded DOWN so a distance never ties above it. */
export function formatRadius(radiusM: number): string {
  const r = Math.round(radiusM);
  if (r < 1000) return `${r} m`;
  return `${(Math.floor(r / 100) / 10).toFixed(1)} km`;
}

/**
 * Rep-facing distance: under 1,000 m → "N m" (whole metres); otherwise "N.N km" (one decimal). With the fence radius,
 * the at-the-radius rule above applies (and an outside km figure is bumped above a km radius: 1,001 m at 1,000 m →
 * "1.1 km", never "1.0 km"). The FE mirrors this exactly (platform/src/lib/geo-distance.ts).
 */
export function formatDistance(meters: number, radiusM?: number | null): string {
  const m = fenceDisplayMeters(meters, radiusM);
  if (m < 1000) return `${m} m`;
  let tenths = Math.round(m / 100);
  if (hasRadius(radiusM)) {
    const radiusTenths = Math.floor(Math.round(radiusM) / 100);
    if (m > radiusM) {
      if (radiusM >= 1000) tenths = Math.max(tenths, radiusTenths + 1);
    } else {
      tenths = Math.min(tenths, radiusTenths);
    }
  }
  return `${(tenths / 10).toFixed(1)} km`;
}

/**
 * The "far from the outlet" block message (every tenant), with the distance and the radius the fence used, naming the
 * farthest out-of-range photo: "Window 2: You are 260 m from the outlet. You need to be within 200 m. Please go to the
 * outlet and try again." / "Window 2 (and 1 more photo): …". Distance unknown → the plain "far" wording; radius unknown
 * → no radius sentence; no label → no prefix.
 */
export function outsideFenceMessage(
  distanceM: number | null | undefined,
  radiusM: number | null | undefined,
  photo?: { label?: string | null; moreCount?: number },
): string {
  const parts: string[] = [];
  parts.push(
    typeof distanceM === 'number' && Number.isFinite(distanceM)
      ? `You are ${formatDistance(distanceM, radiusM)} from the outlet.`
      : 'You are far from the outlet.',
  );
  if (hasRadius(radiusM)) parts.push(`You need to be within ${formatRadius(radiusM)}.`);
  parts.push('Please go to the outlet and try again.');
  const body = parts.join(' ');
  const label = photo?.label?.trim();
  if (!label) return body;
  const more = photo?.moreCount ?? 0;
  const suffix = more > 0 ? ` (and ${more} more photo${more === 1 ? '' : 's'})` : '';
  return `${label}${suffix}: ${body}`;
}
