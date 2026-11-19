/**
 * Location gate for a visibility capture (tenant flag `features.requireLocation`, sales reps only) — pure, so it is
 * unit-testable. See platform/docs/plans/LOCATION-GATE.md and common/location-gate.helper.ts.
 *
 * Rule when the flag is ON (release-gate review 2026-11-19):
 *   1. every location-tagged photo (CAMERA with `geoFenceRequired` or `geotag`) that the rep submits IN THIS REQUEST
 *      (present in the request, visible after validation, not carried forward) must carry a real fix;
 *   2. photos carried forward unchanged (approved photos on a partial re-capture, or earlier answers the server merges
 *      back in) NEVER cause a refusal;
 *   3. the request must carry at least ONE fresh fix: a new tagged photo's fix, a GPS_POINT value sent in this
 *      request, or the phone's submit-time `captureGeo` (new clients always send it);
 *   4. when none of those exists AND the form has no location field the phone could fill (no tagged photo, no GPS
 *      field), the refusal names the FORM problem — never "retake photos".
 * A "real fix" = finite, in-range lat/lng and not the 0,0 null-island default. Returns the message, or null.
 */
import { isRealFix, LOCATION_REQUIRED_VISIBILITY_MESSAGE } from '../common/location-gate.helper';
import { parseGpsPoint } from './visibility-form.helper';
import { readMediaValue, type VisibilityFormSchema } from './visibility-types';

export const VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE =
  'This form has no location field, so the capture has no location — ask Gifsy to add one. (Location is required for this programme.)';

const has = (o: Record<string, unknown> | undefined, k: string) =>
  !!o && Object.prototype.hasOwnProperty.call(o, k);

export function visibilityLocationRefusal(
  schema: VisibilityFormSchema,
  /** The validated (visible-fields-only), merged values that will be stored. */
  values: Record<string, unknown>,
  /** Field ids carried forward unchanged from the earlier version (approved photos). */
  carriedFieldIds: ReadonlySet<string>,
  /** What THIS request sent (before the merge). */
  requestValues: Record<string, unknown> | undefined,
  /** The phone's submit-time fix (optional, new clients). */
  captureGeo?: unknown,
): string | null {
  const fields = schema.fields ?? [];
  const tagged = fields.filter((f) => f.type === 'CAMERA' && (f.geoFenceRequired === true || f.geotag === true));
  const gpsPoints = fields.filter((f) => f.type === 'GPS_POINT');

  // 1 + 2 — new tagged photos in this request must each carry a real fix.
  const missing: string[] = [];
  let freshPhotoFix = false;
  for (const f of tagged) {
    if (carriedFieldIds.has(f.id) || !has(requestValues, f.id) || !has(values, f.id)) continue;
    const media = readMediaValue(values[f.id]);
    if (!media.key) continue; // nothing submitted for it
    if (isRealFix(media.geo)) freshPhotoFix = true;
    else missing.push(f.label || f.id);
  }
  if (missing.length > 0) {
    return `${LOCATION_REQUIRED_VISIBILITY_MESSAGE} No location on: ${missing.map((m) => `"${m}"`).join(', ')}.`;
  }

  // 3 — at least one fresh fix from this request.
  const freshGps = gpsPoints.some((f) => has(requestValues, f.id) && isRealFix(parseGpsPoint(requestValues![f.id])));
  const freshSubmit = isRealFix(parseGpsPoint(captureGeo));
  if (freshPhotoFix || freshGps || freshSubmit) return null;

  // 4 — name the form problem when the form itself cannot produce a location.
  if (tagged.length === 0 && gpsPoints.length === 0) return VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE;
  return LOCATION_REQUIRED_VISIBILITY_MESSAGE;
}
