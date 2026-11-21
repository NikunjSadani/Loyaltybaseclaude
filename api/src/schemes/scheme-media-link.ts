/**
 * Scheme media links for Excel exports (owner-approved 2026-11-21, PLATFORM-WIDE — every tenant incl. Deoleo).
 *
 * Every cell of a scheme export that holds a stored media object key (`scheme-media/<clientId>/<yyyy-mm>/<file>`)
 * becomes a clickable "Open photo" / "Open file" hyperlink to the SIGNED-IN viewer page
 * `/schemes/photo?key=<key>` (platform app/schemes/photo) on the tenant's primary portal host — the same
 * `pickTenantDomain` → `tenantPortalLink` rule as the Visibility report (never a staging host in prod; fallback
 * `<slug>.gifsy.in`). A page navigation, so normal sign-in / session renewal applies and the link never expires; the
 * bytes are served by the role-gated, tenant-pinned `GET /v1/schemes/media/file?key=`.
 *
 * This replaced the 30-day HS256 tokenized `/v1/schemes/media/view?token=` links (that public endpoint is kept so
 * links in files downloaded before this change still work until their token lapses).
 *
 * A raw key is never written as cell text: detection is by VALUE (not only by field type), so legacy values — e.g. a
 * UPI_QR_SCAN field that stored an uploaded image key before it became a live-scan VPA field (2026-09-14) — are
 * linked too. Excel's hyperlink limit (~65,530 per sheet) → after SCHEME_LINK_LIMIT.perSheet links a cell carries the
 * full viewer URL as text (the key inside it is URL-encoded) and the About sheet says how many.
 */
import type { PrismaService } from '../prisma/prisma.service';
import type { HyperlinkCell } from '../common/xlsx';
import { pickTenantDomain, tenantPortalLink } from '../tickets/ticket-link';

export const SCHEME_MEDIA_PREFIX = 'scheme-media/';

/** Mutable so a spec can lower it (mirrors VISIBILITY_LINK_LIMIT). */
export const SCHEME_LINK_LIMIT = { perSheet: 60_000 };

/** The in-app path of the scheme media viewer page for a stored object key. */
export function schemeMediaPath(key: string): string {
  return `/schemes/photo?key=${encodeURIComponent(key)}`;
}

/** The stored scheme-media key carried by a cell value (bare string or `{ key, geo }`), else ''. */
export function schemeMediaKeyOf(value: unknown): string {
  const k =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { key?: unknown }).key === 'string'
        ? (value as { key: string }).key
        : '';
  const t = k.trim();
  return t.startsWith(SCHEME_MEDIA_PREFIX) ? t : '';
}

/** "Open photo" for an image key, "Open file" for a PDF / any non-image key. */
export function schemeMediaLinkText(key: string): 'Open photo' | 'Open file' {
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(key.trim()) ? 'Open photo' : 'Open file';
}

/** Renders one stored media key as an export cell ("Open photo"/"Open file" hyperlink, or the URL past the cap). */
export type MediaCell = (mediaKey: string) => HyperlinkCell | string;

/**
 * A value that carries a stored scheme-media key must never surface as text (e.g. a legacy UPI_QR_SCAN value from
 * before 2026-09-14, when that type uploaded an image; or an uploaded Excel cell). Arrays: a single media item → its
 * link; several → each media item reads "(file)" — a cell holds one link only, and no form field stores more than one.
 */
export function mediaSafe(value: unknown, mediaCell: MediaCell): unknown {
  const key = schemeMediaKeyOf(value);
  if (key) return mediaCell(key);
  if (Array.isArray(value)) {
    const keys = value.map(schemeMediaKeyOf).filter(Boolean);
    if (keys.length === 1 && value.length === 1) return mediaCell(keys[0]);
    if (keys.length > 0) return value.map((v) => (schemeMediaKeyOf(v) ? '(file)' : String(v))).join(', ');
  }
  return value;
}

export interface SchemeMediaLinkWriter {
  /** A hyperlink cell for one key (or, past the per-sheet cap, the viewer URL as text). */
  cell(key: string): HyperlinkCell | string;
  /** Cells written as text because the sheet reached the hyperlink cap. */
  readonly asText: number;
  /** Links written as hyperlinks. */
  readonly links: number;
  /** The portal host the links point at (for the About sheet), or ''. */
  readonly host: string;
  /** Why the host is the `<slug>` fallback, when it is (never silent), else null. */
  readonly note: string | null;
}

/**
 * One writer per SHEET (the cap is per worksheet). `callerOrigin` is only used in a LOCAL environment
 * (tenantPortalLink); `domainRows` = the tenant's ClientDomain rows.
 */
export function createSchemeMediaLinkWriter(params: {
  clientId: string;
  callerOrigin: string;
  domainRows: { domain: string; isPrimary: boolean }[];
  env?: Record<string, string | undefined>;
}): SchemeMediaLinkWriter {
  const picked = pickTenantDomain(params.domainRows, params.clientId, params.env);
  const urlFor = (key: string) =>
    tenantPortalLink({
      callerOrigin: params.callerOrigin,
      tenantPrimaryDomain: picked.domain,
      clientId: params.clientId,
      path: schemeMediaPath(key),
      env: params.env,
    });
  let host = '';
  try {
    host = new URL(urlFor('x')).host;
  } catch {
    host = '';
  }
  let links = 0;
  let asText = 0;
  return {
    cell(key: string) {
      const target = urlFor(key);
      if (links < SCHEME_LINK_LIMIT.perSheet) {
        links++;
        return { __hyperlink: true, text: schemeMediaLinkText(key), target };
      }
      asText++;
      return target;
    },
    get asText() {
      return asText;
    },
    get links() {
      return links;
    },
    host,
    note: picked.note,
  };
}

/** Loads the tenant's domains and builds a writer (one DB read). */
export async function loadSchemeMediaLinkWriter(
  prisma: Pick<PrismaService, 'clientDomain'>,
  clientId: string,
  callerOrigin: string,
): Promise<SchemeMediaLinkWriter> {
  const rows = await prisma.clientDomain.findMany({ where: { clientId }, select: { domain: true, isPrimary: true } });
  return createSchemeMediaLinkWriter({ clientId, callerOrigin, domainRows: Array.isArray(rows) ? rows : [] });
}

/**
 * The plain-words About rows for a sheet's media links (shared by the enrollment + roster exports). `sheet` = the
 * sheet whose cells hold the links.
 */
export function schemeMediaAboutRows(w: SchemeMediaLinkWriter, sheet: string): Array<{ Item: string; Details: string }> {
  const rows: Array<{ Item: string; Details: string }> = [
    {
      Item: 'PHOTO / FILE LINKS',
      Details: `Each "Open photo" / "Open file" link in the ${sheet} sheet opens that photo or document in the portal${w.host ? ` (${w.host})` : ''}. You must be signed in with an account of this programme that may view scheme data; if you are not signed in, the portal asks you to sign in and then opens it. The links do not expire, and they never work for anyone outside the programme.`,
    },
  ];
  if (w.note) rows.push({ Item: 'Link address', Details: w.note });
  if (w.asText > 0) {
    rows.push({
      Item: 'LINK LIMIT',
      Details: `Excel allows about 65,000 links per sheet. The first ${SCHEME_LINK_LIMIT.perSheet.toLocaleString('en-IN')} photos/files in the ${sheet} sheet are clickable; the remaining ${w.asText.toLocaleString('en-IN')} show the full link address as text — copy it into the browser.`,
    });
  }
  return rows;
}
