/**
 * The Visibility photo viewer page (`/visibility/photo?key=…`) — the target of every "Open photo" link in the
 * Visibility Excel report (api exports/kinds/batch1/visibility-captures.ts `visibilityPhotoPath`).
 *
 * It is a normal signed-in PAGE (never public): the edge proxy renews the session or sends the person to sign in
 * with `next`. The page renders for ANY signed-in role (no proxy ROLE_ROUTES entry) — the backend media endpoint
 * (`GET /v1/visibility/captures/media`) decides, and the page shows "You don't have access" on its 403.
 * After sign-in EVERY role is brought back to the photo (return-to.ts) so a role without access reads the message.
 * VISIBILITY_PHOTO_ROLES = the roles the media endpoint serves (documentation / tests).
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
