/**
 * The scheme media viewer page (`/schemes/photo?key=…`) — the target of every "Open photo" / "Open file" link in the
 * scheme enrollment Excel export (api schemes/scheme-media-link.ts `schemeMediaPath`).
 *
 * Like the Visibility photo viewer it is a normal signed-in PAGE (never public), with no proxy ROLE_ROUTES entry: it
 * renders for ANY signed-in role and the backend media endpoint (`GET /v1/schemes/media/file?key=`) decides — roles via
 * @Roles + schemes:read, tenant from the key's folder (403 for another programme's file). After sign-in EVERY role is
 * brought back here (return-to.ts) so a role without access reads the message instead of losing the link.
 *
 * The links never expire (unlike the old 30-day tokenized `/v1/schemes/media/view?token=` links in exports made
 * before this change, which keep working until their token lapses).
 */
export const SCHEME_PHOTO_PATH = '/schemes/photo';

/** The roles the scheme media endpoint serves (documentation / tests) — mirrors scheme-enrollment.controller. */
export const SCHEME_PHOTO_ROLES: string[] = [
  'GIFSY_ADMIN',
  'CLIENT_ADMIN',
  'SSS',
  'WHOLESALER',
  'SUB_STOCKIST',
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
];

/** Browser URL of the role-gated scheme media stream for a stored object key. */
export function schemePhotoMediaUrl(key: string): string {
  return `/api/schemes/media/file?key=${encodeURIComponent(key)}`;
}

/** A key that is (by its name) a PDF / non-image file — the page then says "file" instead of "photo" until loaded. */
export function isSchemeFileKey(key: string): boolean {
  return !/\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i.test(key.trim());
}

/** The FULL stored scheme-media key shape (mirrors api scheme-media-link SCHEME_MEDIA_KEY_RE). */
export const SCHEME_MEDIA_KEY_RE = /^scheme-media\/[A-Za-z0-9_-]+\/\d{4}-(0[1-9]|1[0-2])\/[^/\s\\]+$/;

export function isSchemeMediaKey(v: unknown): v is string {
  return typeof v === 'string' && SCHEME_MEDIA_KEY_RE.test(v.trim()) && !v.split('/').some((s) => s === '.' || s === '..');
}

/** In-app path of the scheme media viewer page for a key. */
export function schemePhotoPagePath(key: string): string {
  return `${SCHEME_PHOTO_PATH}?key=${encodeURIComponent(key.trim())}`;
}
