/**
 * Location gate for a visibility capture (tenant flag `features.requireLocation`, sales reps only) — pure, so it is
 * unit-testable. See platform/docs/plans/LOCATION-GATE.md and common/location-gate.helper.ts.
 *
 * Rule when the flag is ON:
 *   • every LOCATION-TAGGED photo the rep submits now (CAMERA with `geoFenceRequired` or `geotag`, with a media key)
 *     must carry a valid fix (finite, in-range lat/lng). Photos carried forward unchanged from an earlier version
 *     (partial re-capture of approved photos) are not re-checked — they were taken before;
 *   • a form with GPS_POINT field(s) and no location-tagged photo must have at least one valid GPS_POINT value;
 *   • a form with NO location field at all cannot satisfy the rule → refused with a message that says so (the
 *     form must be fixed by Gifsy; we never silently let a location-less capture through).
 * Returns the refusal message, or null when the capture may proceed.
 */
import { isValidGeo } from './geo-fence.helper';
import { parseGpsPoint } from './visibility-form.helper';
import { readMediaValue, type VisibilityFormSchema } from './visibility-types';
import { LOCATION_REQUIRED_VISIBILITY_MESSAGE } from '../common/location-gate.helper';

export function visibilityLocationRefusal(
  schema: VisibilityFormSchema,
  values: Record<string, unknown>,
  carriedFieldIds: ReadonlySet<string>,
): string | null {
  const fields = schema.fields ?? [];
  const tagged = fields.filter((f) => f.type === 'CAMERA' && (f.geoFenceRequired === true || f.geotag === true));
  const gpsPoints = fields.filter((f) => f.type === 'GPS_POINT');

  if (tagged.length === 0 && gpsPoints.length === 0) {
    return 'Location is required for this programme, but the visibility form has no location field, so no capture can be accepted. Please ask Gifsy to add a location to the form.';
  }

  if (tagged.length > 0) {
    const missing: string[] = [];
    for (const f of tagged) {
      if (carriedFieldIds.has(f.id)) continue;
      const media = readMediaValue(values[f.id]);
      if (!media.key) continue; // not submitted (optional / hidden) — nothing to check
      if (!isValidGeo(media.geo)) missing.push(f.label || f.id);
    }
    if (missing.length > 0) {
      return `${LOCATION_REQUIRED_VISIBILITY_MESSAGE} No location on: ${missing.map((m) => `"${m}"`).join(', ')}.`;
    }
    // Every submitted tagged photo had a fix — but the capture must carry at least ONE fix (e.g. all tagged photos
    // optional and left empty → no location evidence at all). Carried-forward photos with a fix count.
    const anyFix =
      tagged.some((f) => isValidGeo(readMediaValue(values[f.id]).geo)) ||
      gpsPoints.some((f) => parseGpsPoint(values[f.id]) !== null);
    return anyFix ? null : LOCATION_REQUIRED_VISIBILITY_MESSAGE;
  }

  const anyValid = gpsPoints.some((f) => parseGpsPoint(values[f.id]) !== null);
  return anyValid ? null : LOCATION_REQUIRED_VISIBILITY_MESSAGE;
}
