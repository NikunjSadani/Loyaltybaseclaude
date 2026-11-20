/**
 * The Visibility photo viewer page (`/visibility/photo?key=…`) — the target of every "Open photo" link in the
 * Visibility Excel report (api exports/kinds/batch1/visibility-captures.ts `visibilityPhotoPath`).
 *
 * It is a normal signed-in PAGE (never public): the edge proxy renews the session or sends the person to sign in
 * with `next`, then brings them back here. Admitted roles = the roles the backend media endpoint
 * (`GET /v1/visibility/captures/media`) serves; the backend still decides per photo (tenant folder pinning).
 */
export const VISIBILITY_PHOTO_PREFIX = '/visibility';
export const VISIBILITY_PHOTO_PATH = '/visibility/photo';

export const VISIBILITY_PHOTO_ROLES: string[] = [
  'GIFSY_ADMIN',
  'GIFSY_STAFF',
  'CLIENT_ADMIN',
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
];

/** Browser URL of the role-gated media stream for a stored object key. */
export function visibilityPhotoMediaUrl(key: string): string {
  return `/api/visibility/captures/media?key=${encodeURIComponent(key)}`;
}
