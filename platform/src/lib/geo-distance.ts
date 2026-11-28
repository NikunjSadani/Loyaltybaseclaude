/**
 * lib/geo-distance.ts — the rep-facing "Distance from outlet" wording (owner 2026-11-28).
 *
 * Reps read the phone's GPS accuracy ("±13m") as their distance from the outlet, then got "far from the outlet".
 * Capture screens now show NO accuracy figure; on a geo-fenced photo they show the distance the FENCE measures.
 *
 * The NUMBER always comes from the server (POST /v1/visibility/sales/fence-distance — whole metres — or the submit
 * response / block message), computed by the same helper the fence decides with (api geo-fence.helper
 * fenceDistanceMeters). Only the FORMAT is mirrored here; it must stay identical to the api's `fenceDisplayMeters` /
 * `formatDistance` / `formatRadius` (api/src/visibility/geo-fence.helper.ts) — the FE cannot import the api package.
 *
 * At-the-radius rule (never a contradiction with the verdict): an OUTSIDE distance (> radius) is rounded UP so it
 * always reads above the radius (200.3 m → "201 m"); an INSIDE one is normally rounded but never shown above it.
 */

const hasRadius = (r: number | null | undefined): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0;

/** Whole metres as shown. Mirrors api `fenceDisplayMeters`. Idempotent for a whole-metre input. */
export function fenceDisplayMeters(rawM: number, radiusM?: number | null): number {
  if (!hasRadius(radiusM)) return Math.round(rawM);
  if (rawM > radiusM) return Math.ceil(rawM);
  return Math.min(Math.round(rawM), Math.floor(radiusM));
}

/** "200 m" / "1.5 km" — km rounded DOWN. Mirrors api `formatRadius`. */
export function formatRadius(radiusM: number): string {
  const r = Math.round(radiusM);
  if (r < 1000) return `${r} m`;
  return `${(Math.floor(r / 100) / 10).toFixed(1)} km`;
}

/** Under 1,000 m → "N m"; otherwise "N.N km"; at-the-radius rule when a radius is given. Mirrors api `formatDistance`. */
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

/** The rep's distance line. Null when there is no usable distance (no line is shown). */
export function distanceFromOutletLabel(
  meters: number | null | undefined,
  radiusM?: number | null,
): { text: string; outside: boolean } | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null;
  const outside = hasRadius(radiusM) && meters > radiusM;
  const base = `Distance from outlet: ${formatDistance(meters, radiusM)}`;
  return outside
    ? { text: `${base} — outside the ${formatRadius(radiusM as number)} limit`, outside: true }
    : { text: base, outside: false };
}
