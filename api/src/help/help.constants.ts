import { createHash } from 'node:crypto';

/**
 * Help & videos — shared limits + pure helpers (no Nest / Prisma imports, so specs and the FE contract can
 * reason about them directly). See platform/docs/plans/HELP-VIDEOS.md.
 */

const MiB = 1024 * 1024;

/** Max stored video size (owner spec: ~50 MB). */
export const HELP_VIDEO_MAX_BYTES = 50 * MiB;
/**
 * Chunk size for the video upload. The Next `/api` proxy truncates request bodies above 15 MB
 * (next.config.ts `proxyClientMaxBodySize`), and multer buffers each part in API memory, so a 50 MB
 * video goes up as ≤ 8 MiB parts that GCS composes server-side (StorageService.combineFiles).
 */
export const HELP_VIDEO_PART_BYTES = 8 * MiB;
/** ceil(50 / 8) = 7 parts for a maximal video. GCS compose accepts ≤ 32 sources. */
export const HELP_VIDEO_MAX_PARTS = Math.ceil(HELP_VIDEO_MAX_BYTES / HELP_VIDEO_PART_BYTES);
/** Poster image cap (same as every other photo upload). */
export const HELP_POSTER_MAX_BYTES = 5 * MiB;
export const HELP_POSTER_MIME: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const HELP_TITLE_MAX = 80;
export const HELP_DESCRIPTION_MAX = 200;
export const HELP_STEP_MAX = 200;
export const HELP_STEPS_MIN_TO_PUBLISH = 3;
export const HELP_STEPS_MAX = 6;
export const HELP_ROLES_MAX = 20;
export const HELP_TOPICS_MAX_PER_TENANT = 100;

/** Lifetime of a member/console media token (the signed URL). Covers watching a short video end-to-end. */
export const HELP_MEDIA_TOKEN_TTL_SEC = 60 * 60;
export const HELP_MEDIA_TOKEN_TYP = 'helpmedia';
/** Browser path (FE `/api/*` → backend `/v1/*` rewrite) — same-origin, so helmet's CORP is satisfied. */
export const HELP_MEDIA_ROUTE = '/api/help/media';

export type HelpAudience = 'SALES' | 'PARTNER';

/** Sales-app login roles (UserRole) — the console offers these plus the tenant's hierarchy-level codes. */
export const SALES_USER_ROLES = ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'] as const;
/** Partner-app login roles (UserRole) — the console offers these plus the tenant's outlet-type codes. */
export const PARTNER_USER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'] as const;

/**
 * Is an MP4 (ISO-BMFF `ftyp` box at byte 4)? QuickTime (`qt  ` brand) is refused: Chrome/Android often cannot
 * play it. Returns null when OK, else a user-facing reason.
 */
export function mp4Problem(head: Buffer | undefined | null): string | null {
  if (!head || head.length < 12) return 'The file is empty or too short to be a video.';
  if (head.subarray(4, 8).toString('latin1') !== 'ftyp') {
    return 'This is not an MP4 video. Export the video as .mp4 (H.264) and upload again.';
  }
  const brand = head.subarray(8, 12).toString('latin1');
  if (brand === 'qt  ') {
    return 'This is a QuickTime (.mov) file, which many phones cannot play. Export it as .mp4 (H.264) and upload again.';
  }
  // HEIF/AVIF images share the ftyp box — not a video.
  if (['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) {
    return 'This is an image, not a video. Upload an .mp4 video.';
  }
  return null;
}

/**
 * Does a topic's role filter admit this viewer? An EMPTY filter = everyone in the audience. `viewerRoles` holds
 * every label the viewer carries (login role + hierarchy level / outlet-type codes). Case-insensitive.
 */
export function roleFilterAdmits(topicRoles: readonly string[], viewerRoles: readonly (string | null | undefined)[]): boolean {
  if (!topicRoles || topicRoles.length === 0) return true;
  const have = new Set(viewerRoles.filter((r): r is string => typeof r === 'string' && r.length > 0).map((r) => r.toUpperCase()));
  return topicRoles.some((r) => have.has(r.toUpperCase()));
}

/** Parse a single `bytes=a-b` / `bytes=a-` / `bytes=-n` Range header against a size. null = serve the whole object. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range / malformed → ignore and send 200 (RFC 7233 allows that)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    // RFC 7233 §2.1: last-byte-pos < first-byte-pos makes the spec INVALID → ignore the header (200, full body).
    if (b !== '' && Number(b) < start) return null;
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Short, stable fingerprint of an object key, carried in a media token so a REPLACED video/poster invalidates it. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Prefix for in-progress chunked uploads (a 1-day GCS lifecycle Delete rule sweeps abandoned ones). */
export const HELP_UPLOAD_PREFIX = 'help-uploads/';

/** Per-token request ceiling on the public media route (a video plays as a handful of Range requests). */
export const HELP_MEDIA_PER_TOKEN_PER_MIN = 600;
/** Per-IP ceiling. Behind the Next `/api` rewrite `req.ip` is the frontend, so this is a per-instance backstop. */
export const HELP_MEDIA_PER_IP_PER_MIN = 6000;
/** Simultaneous open streams per token (Chrome/Safari use 1–3 for one <video>). */
export const HELP_MEDIA_MAX_CONCURRENT_PER_TOKEN = 4;

/** Normalise the steps list: trim, drop blanks. */
export function cleanSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length > 0);
}
