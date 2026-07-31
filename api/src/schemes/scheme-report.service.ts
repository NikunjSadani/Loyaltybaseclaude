import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { buildXlsx, HyperlinkCell } from '../common/xlsx';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { EnrollmentFormSchema, FormField } from './enrollment-form.helper';
import {
  AudienceFilter,
  buildOutletWhereFromFilter,
  OUTLET_NAME_HEADER_ALIASES,
} from './scheme-roster.helper';

/**
 * Inline-safe mime allowlist for the PUBLIC media-view endpoint — identical to the
 * KYC doc-view / enrollment-stream allowlist. Anything outside this set is served
 * as an octet-stream attachment (downloaded, never executed in the app origin).
 */
const INLINE_SAFE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/** normalize = trim + lowercase + collapse internal whitespace (bug 1 / bug 3). */
function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The broadened outlet-name aliases as a normalized Set for O(1) case-insensitive lookup. */
const NAME_ALIAS_SET: ReadonlySet<string> = new Set(
  OUTLET_NAME_HEADER_ALIASES.map((h) => normalizeKey(h)),
);

/**
 * Field types whose captured value is a stored GCS object key (media). In the
 * export these render as an AUTH-GATED view link (D30), NOT the raw key. Kept
 * local so it stays correct even as enrollment-form.helper's FORM_FIELD_TYPES is
 * extended by the sibling stream (adds SIGNATURE etc.).
 */
export const MEDIA_FIELD_TYPES = new Set<string>([
  'DOCUMENT',
  'IMAGE',
  'CAMERA',
  'UPI_QR_SCAN',
  'SIGNATURE',
]);

/** A roster row + its (optional) current enrollment, as loaded for the export. */
export interface ExportRosterRow {
  outletRef: string;
  outletName: string;
  /** Real name of the matched loyalty outlet — used as the Outlet Name fallback. */
  matchedOutletName: string | null;
  matchedOutletId: string | null;
  zone: string | null;
  programName: string | null;
  programCategory: string | null;
  outletType: string | null;
  taggedEmployeeCode: string | null;
  /** The uploaded audience-Excel columns for this row (original header → value). */
  prefillValues: Record<string, unknown> | null;
  /**
   * The LIVE enrollment's id (the current submission snapshot the export renders),
   * or null when the row is not enrolled / soft-deleted. Threaded into the media
   * view-token (`sub`) so the PUBLIC endpoint resolves the object key server-side.
   */
  enrollmentId: string | null;
  enrollment: {
    status: string;
    currentVersion: number;
    formValues: unknown;
    enrolledAt: Date;
    rejectionReason: string | null;
    submittedByName: string | null;
    submittedByPhone: string | null;
    /** Employee code of the submitting rep when they are a SalesUser (else null). */
    submittedByEmployeeCode: string | null;
  } | null;
}

/** One export column + a human note on where its value comes from (legend sheet). */
export interface ExportColumn {
  name: string;
  source: string;
}

/**
 * Render ONE captured field value for the export cell.
 *   - media field (key present)  → a REAL Excel hyperlink (HyperlinkCell) whose
 *                                  target is the PUBLIC tokenized view URL (`mintLink`)
 *   - GPS_POINT ({lat,lng,...})   → "lat, lng (±acc)"
 *   - array (multi-select)        → comma-joined
 *   - object                      → JSON
 *   - primitive                   → String()
 * Null/undefined/'' → ''. Injection-safety is applied downstream by buildXlsx
 * (jsonToSheetSafe/cellSafe on every string cell — and the hyperlink display text),
 * so callers pass raw strings.
 */
export function renderExportValue(
  field: FormField,
  value: unknown,
  mintLink: (mediaKey: string) => string,
): string | HyperlinkCell {
  if (value === null || value === undefined || value === '') return '';

  // TOGGLE (boolean) → human "Yes"/"No" instead of the raw "true"/"false" string.
  // A real `false` reaches here (it passes the null/'' guard above) and must render
  // "No", never ''. Truthy = boolean true, or a truthy string form.
  if (field.type === 'TOGGLE') {
    const truthy =
      value === true ||
      (typeof value === 'string' && ['true', 'yes', '1', 'on'].includes(value.trim().toLowerCase()));
    return truthy ? 'Yes' : 'No';
  }

  if (MEDIA_FIELD_TYPES.has(field.type)) {
    const key = typeof value === 'string' ? value : String((value as { key?: string })?.key ?? '');
    if (!key) return '';
    // A clickable "View image" link that opens from a downloaded .xlsx. The target
    // is a self-authenticating tokenized URL (mintLink) — NOT the raw key.
    return { __hyperlink: true, text: 'View image', target: mintLink(key) };
  }

  if (field.type === 'GPS_POINT' && typeof value === 'object') {
    const g = value as { lat?: unknown; lng?: unknown; accuracy?: unknown };
    if (g.lat != null && g.lng != null) {
      const acc = g.accuracy != null ? ` (±${String(g.accuracy)})` : '';
      return `${String(g.lat)}, ${String(g.lng)}${acc}`;
    }
  }

  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Resolve a row's Outlet Name (bug 1). Fallback chain:
 *   outletName (non-empty) → matchedOutletName → prefillValues[<any name alias>] → ''.
 *
 * The third step repairs already-uploaded rosters whose name landed in `prefillValues`
 * under a header the OLD parser didn't recognise (e.g. "Shop Name") — the row then had
 * `outletName=''` and a blank name in the export. `consumedKey` reports which prefill
 * header supplied the name so the caller can avoid emitting it as a duplicate column.
 */
export function resolveOutletName(r: ExportRosterRow): { name: string; consumedKey: string | null } {
  if (r.outletName?.trim()) return { name: r.outletName, consumedKey: null };
  if (r.matchedOutletName) return { name: r.matchedOutletName, consumedKey: null };

  const pv = r.prefillValues;
  if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
    for (const [k, v] of Object.entries(pv)) {
      if (NAME_ALIAS_SET.has(normalizeKey(k)) && typeof v === 'string' && v.trim() !== '') {
        return { name: v, consumedKey: k };
      }
    }
  }
  return { name: '', consumedKey: null };
}

/**
 * Build the export rows + a self-documenting column legend (pure). Every row has
 * an IDENTICAL key set — inserted in a FIXED grouped order (Identity → uploaded
 * Excel columns → master attrs → status → captured form values) — so buildXlsx,
 * which derives the header from the FIRST row's keys, never drops a column when
 * the first roster row has no enrollment. Media fields become auth-gated links
 * via `mintLink`. The returned `columns` drive a second "Columns" legend sheet.
 *
 * Column sourcing:
 *   - Identity/master/status  → the roster row + matched loyalty outlet master.
 *   - Uploaded-Excel columns  → the UNION of every row's `prefillValues` keys,
 *                               emitted under their ORIGINAL header text; a header
 *                               that clashes with a base/master/status/form-field
 *                               column is de-collided with a ` (Excel)` suffix so
 *                               it never overwrites the reserved base column.
 *   - Captured form values    → one column per form field (`formValues[fieldId]`).
 */
export function buildEnrollmentExportRows(
  roster: ExportRosterRow[],
  fields: FormField[],
  mintLink: (submissionId: string, fieldId: string) => string,
): { rows: Record<string, unknown>[]; columns: ExportColumn[] } {
  // De-collide duplicate field labels so no column silently overwrites another.
  const seen = new Map<string, number>();
  const columnFor = new Map<string, string>(); // fieldId → column header
  for (const f of fields) {
    const base = f.label?.trim() || f.id;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    columnFor.set(f.id, n === 1 ? base : `${base} (${n})`);
  }

  // The reserved (non-Excel) headers: base identity, master attrs, status, and
  // every form-field column. An uploaded Excel header colliding with any of these
  // is suffixed ` (Excel)` rather than dropped (RESERVED-collision trap) so the
  // base column value always wins and the Excel data is still surfaced.
  const identityCols = ['Outlet Ref', 'Outlet Name', 'Matched', 'Tagged Employee', 'Submitted By (Employee)'];
  const masterCols = ['Zone', 'Program', 'Program Category', 'Outlet Type'];
  const statusCols = ['Status', 'Version', 'Enrolled At', 'Submitted By', 'Submitted By Phone', 'Rejection Reason'];
  const reserved = new Set<string>([...identityCols, ...masterCols, ...statusCols, ...columnFor.values()]);

  // Bug 1: resolve the Outlet Name per row and remember WHICH prefill header (if any)
  // supplied it, so bug-3 can claim that header (avoid duplicating the name column).
  const nameFor = new Map<ExportRosterRow, string>();
  const consumedNameKeysNorm = new Set<string>();
  for (const r of roster) {
    const { name, consumedKey } = resolveOutletName(r);
    nameFor.set(r, name);
    if (consumedKey) consumedNameKeysNorm.add(normalizeKey(consumedKey));
  }

  // Bug 3: the normalized set of prefill headers a form field already surfaces —
  // every field's `prefillKey` (the captured column falls back to the uploaded value
  // for un-enrolled rows), PLUS the name-alias header(s) the Outlet Name cell consumed.
  // An uploaded column whose normalized header is claimed is NOT re-emitted as a
  // separate ` (Excel)` duplicate; the ` (Excel)` suffix is reserved ONLY for a
  // genuinely-unrelated header that clashes with an identity/master/status header.
  const claimedPrefillNorm = new Set<string>(consumedNameKeysNorm);
  for (const f of fields) {
    if (typeof f.prefillKey === 'string' && f.prefillKey.trim() !== '') {
      claimedPrefillNorm.add(normalizeKey(f.prefillKey));
    }
  }

  // UNION of every row's uploaded-Excel columns (first-seen order), skipping any header
  // a field/identity cell already surfaces (claimed), and de-colliding a genuinely-
  // unrelated clash with a reserved header. `origKey` reads the value, `header` names it.
  const excelCols: { origKey: string; header: string }[] = [];
  const excelSeen = new Set<string>();
  for (const r of roster) {
    const pv = r.prefillValues;
    if (!pv || typeof pv !== 'object' || Array.isArray(pv)) continue;
    for (const origKey of Object.keys(pv)) {
      if (excelSeen.has(origKey)) continue;
      excelSeen.add(origKey);
      if (claimedPrefillNorm.has(normalizeKey(origKey))) continue; // merged into a field/identity column
      excelCols.push({ origKey, header: reserved.has(origKey) ? `${origKey} (Excel)` : origKey });
    }
  }

  const rows = roster.map((r) => {
    const values = (r.enrollment?.formValues ?? {}) as Record<string, unknown>;
    const pv = (r.prefillValues ?? {}) as Record<string, unknown>;
    // Case-insensitive prefill lookup (bug 3 captured-column fallback + prefillKey match).
    const pvByNorm = new Map<string, unknown>();
    for (const [k, v] of Object.entries(pv)) pvByNorm.set(normalizeKey(k), v);
    // Per-row media minter: bind this row's live enrollment id + the field id. No live
    // enrollment (not enrolled / soft-deleted) → no media, so no token is minted.
    const rowMint = (fieldId: string): string => (r.enrollmentId ? mintLink(r.enrollmentId, fieldId) : '');
    const row: Record<string, unknown> = {};
    // Identity
    row['Outlet Ref'] = r.outletRef;
    row['Outlet Name'] = nameFor.get(r) ?? '';
    row['Matched'] = r.matchedOutletId ? 'Yes' : 'No';
    row['Tagged Employee'] = r.taggedEmployeeCode ?? '';
    row['Submitted By (Employee)'] = r.enrollment?.submittedByEmployeeCode ?? '';
    // Uploaded audience-Excel columns (blank where a row lacks that key).
    for (const c of excelCols) row[c.header] = pv[c.origKey] ?? '';
    // Master attrs (matched loyalty outlet)
    row['Zone'] = r.zone ?? '';
    row['Program'] = r.programName ?? '';
    row['Program Category'] = r.programCategory ?? '';
    row['Outlet Type'] = r.outletType ?? '';
    // Status
    row['Status'] = r.enrollment?.status ?? 'NOT_ENROLLED';
    row['Version'] = r.enrollment?.currentVersion ?? '';
    row['Enrolled At'] = r.enrollment ? r.enrollment.enrolledAt.toISOString() : '';
    row['Submitted By'] = r.enrollment?.submittedByName ?? '';
    row['Submitted By Phone'] = r.enrollment?.submittedByPhone ?? '';
    row['Rejection Reason'] = r.enrollment?.rejectionReason ?? '';
    // Captured form values. Bug 3: fall back to the uploaded prefill value (matched by
    // prefillKey, case-insensitive) when the row has no captured value — so each logical
    // field is ONE always-populated column (captured when enrolled, else the prefill).
    for (const f of fields) {
      const captured = values[f.id];
      const prefill =
        typeof f.prefillKey === 'string' && f.prefillKey.trim() !== ''
          ? pvByNorm.get(normalizeKey(f.prefillKey))
          : undefined;
      // Prefill fallback is for TEXT-ish fields only. A MEDIA field stores a GCS object
      // key as its captured value; an uploaded prefill string is NOT a key, so falling
      // back to it would render a bogus "View image" hyperlink pointing at a non-key
      // (mintLink ignores it → empty/404 target). Media fields therefore use the captured
      // value ONLY (empty cell when not captured), never the prefill.
      const effective = MEDIA_FIELD_TYPES.has(f.type) ? captured : captured ?? prefill;
      row[columnFor.get(f.id) as string] = renderExportValue(f, effective, () => rowMint(f.id));
    }
    return row;
  });

  // The legend, in the SAME column order as the rows.
  const columns: ExportColumn[] = [
    { name: 'Outlet Ref', source: 'Audience Excel upload (outlet reference)' },
    { name: 'Outlet Name', source: 'Audience Excel upload, else matched loyalty outlet master' },
    { name: 'Matched', source: 'Whether the roster row is linked to a loyalty outlet' },
    { name: 'Tagged Employee', source: 'Audience Excel upload (tagged employee code)' },
    { name: 'Submitted By (Employee)', source: "Submitting rep's employee code (sales user)" },
    ...excelCols.map((c) => ({ name: c.header, source: 'Audience Excel upload' })),
    { name: 'Zone', source: 'Matched loyalty outlet master' },
    { name: 'Program', source: 'Matched loyalty outlet master' },
    { name: 'Program Category', source: 'Matched loyalty outlet master' },
    { name: 'Outlet Type', source: 'Matched loyalty outlet master' },
    { name: 'Status', source: 'Enrollment record' },
    { name: 'Version', source: 'Enrollment record' },
    { name: 'Enrolled At', source: 'Enrollment record' },
    { name: 'Submitted By', source: 'Enrollment record (submitting user)' },
    { name: 'Submitted By Phone', source: 'Enrollment record (submitting user)' },
    { name: 'Rejection Reason', source: 'Enrollment record' },
    ...fields.map((f) => ({ name: columnFor.get(f.id) as string, source: 'Captured on the enrollment form' })),
  ];

  return { rows, columns };
}

/** Generic roster tally: rows + enrolled-count per bucket, sorted by size desc. */
function tally(
  roster: { id: string; key: string | null }[],
  enrolledIds: Set<string>,
): { key: string; rosterCount: number; enrolledCount: number }[] {
  const m = new Map<string, { key: string; rosterCount: number; enrolledCount: number }>();
  for (const r of roster) {
    const key = r.key && r.key.trim() ? r.key : 'Unspecified';
    const b = m.get(key) ?? { key, rosterCount: 0, enrolledCount: 0 };
    b.rosterCount++;
    if (enrolledIds.has(r.id)) b.enrolledCount++;
    m.set(key, b);
  }
  return [...m.values()].sort((a, b) => b.rosterCount - a.rosterCount);
}

/**
 * Scheme reports (D26/D30).
 *   - gifsyReport   — full aggregates for the Gifsy admin (roster/enrolled counts,
 *                     coverage %, breakdowns by status/zone/program/outletType).
 *   - tenantReport  — read-only subset for the tenant admin: the same aggregates
 *                     PLUS a per-outlet row list, but NO raw media/formValues (D26).
 *   - exportEnrollments — xlsx of roster rows + captured field values, each media
 *                     field rendered as an auth-gated view link (D30).
 * All tenant-scoped by clientId.
 */
@Injectable()
export class SchemeReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Mint a self-contained, 30-day media view token + its absolute app-proxy URL for
   * the export link (bug 2). Mirrors the KYC doc-view token EXACTLY:
   *   - HS256 JWT signed with JWT_SECRET, expiresIn '30d'
   *   - carries ONLY { sub: <enrollmentId>, clientId, fieldId, typ: 'schememedia' }
   *
   * `sub` is the LIVE enrollment id (SchemeEnrollment) — the current submission
   * snapshot the export renders (`SchemeEnrollment.formValues[fieldId]` is the GCS
   * object key). The token carries NO raw object key: the PUBLIC endpoint re-resolves
   * it server-side from the tenant-verified enrollment (viewMediaByToken). Type-gated
   * (`typ:'schememedia'`) so it can never be replayed at the doc-view endpoint (and a
   * docview/access token can never be replayed here).
   *
   * The URL is the app-PROXY path (/api/… → backend /v1/…), made ABSOLUTE against the
   * tenant host the admin downloaded from so the link is clickable from a .xlsx opened
   * outside the browser. No host → proxy-relative (still the correct, UNauthenticated path).
   */
  private mediaViewLink(enrollmentId: string, clientId: string, fieldId: string, host: string): string {
    const token = this.jwt.sign(
      { sub: enrollmentId, clientId, fieldId, typ: 'schememedia' },
      { secret: this.config.get('JWT_SECRET'), expiresIn: '30d' },
    );
    const path = `/api/schemes/media/view?token=${encodeURIComponent(token)}`;
    return host ? `https://${host}${path}` : path;
  }

  /**
   * GET /v1/schemes/media/view?token=<jwt> (PUBLIC) — stream a scheme enrollment
   * media object inline, authorised SOLELY by the token. Mirrors KycService.viewDocument
   * line-for-line.
   *
   * Security contract — on ANY failure throw a BARE NotFoundException (no detail) so the
   * endpoint never enumerates media or leaks why a request failed:
   *   - token missing / malformed / bad signature / expired  → 404
   *   - payload.typ !== 'schememedia'                         → 404 (replay guard)
   *   - enrollment not found / soft-deleted                   → 404
   *   - enrollment's tenant (scheme.clientId) ≠ token clientId → 404 (cross-tenant guard)
   *   - object key missing / not this tenant's scheme-media   → 404
   *
   * There is no logged-in user on this public route, so the token IS the authority; the
   * object key is NEVER taken from the token — it is resolved from the tenant-verified
   * enrollment's stored formValues for the token's fieldId.
   */
  async viewMediaByToken(token: string): Promise<{ bytes: Buffer; contentType: string; inline: boolean }> {
    const deny = () => new NotFoundException();

    if (!token || typeof token !== 'string') throw deny();

    let payload: { sub?: unknown; clientId?: unknown; fieldId?: unknown; typ?: unknown };
    try {
      // Pin HS256 (never accept alg:none or an asymmetric-key confusion).
      payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET'), algorithms: ['HS256'] });
    } catch {
      throw deny();
    }

    if (payload.typ !== 'schememedia') throw deny();
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.clientId !== 'string' ||
      typeof payload.fieldId !== 'string'
    ) {
      throw deny();
    }

    const enrollmentId = payload.sub;
    const tokenClientId = payload.clientId;
    const fieldId = payload.fieldId;

    // Load the enrollment + walk to its real tenant: SchemeEnrollment → scheme.clientId.
    const enrollment = await this.prisma.schemeEnrollment.findUnique({
      where: { id: enrollmentId },
      select: { formValues: true, deletedAt: true, scheme: { select: { clientId: true } } },
    });
    if (!enrollment) throw deny();
    // A soft-deleted enrollment leaks nothing (parity with the export's own guard).
    if (enrollment.deletedAt != null) throw deny();

    // Cross-tenant guard: the enrollment's owning tenant MUST equal the token's clientId.
    const enrClientId = enrollment.scheme?.clientId;
    if (!enrClientId || enrClientId !== tokenClientId) throw deny();

    const values =
      enrollment.formValues && typeof enrollment.formValues === 'object' && !Array.isArray(enrollment.formValues)
        ? (enrollment.formValues as Record<string, unknown>)
        : null;
    if (!values) throw deny();

    const key = values[fieldId];
    if (typeof key !== 'string' || !key) throw deny();
    // Defense-in-depth: only ever serve THIS tenant's scheme-media objects, even if a
    // token's fieldId pointed at a non-media field storing an arbitrary string.
    if (!key.startsWith(`scheme-media/${tokenClientId}/`)) throw deny();

    const file = await this.storage.downloadBytes(key);
    if (!file) throw deny();

    // Same safe-mime inline allowlist as viewDocument: image/pdf inline, everything
    // else forced to an octet-stream attachment (downloaded, never executed).
    const rawMime = (file.contentType || '').toLowerCase();
    const inline = INLINE_SAFE_MIME.has(rawMime);
    return { bytes: file.bytes, contentType: inline ? rawMime : 'application/octet-stream', inline };
  }

  /** Loose parse of the stored audienceConfig for the coverage-denominator decision. */
  private parseAudience(
    raw: unknown,
  ): { mode: 'FILTER' | 'EXCEL'; frozen: boolean; filter?: AudienceFilter } | null {
    if (!raw || typeof raw !== 'object') return null;
    const cfg = raw as { mode?: string; frozen?: boolean; filter?: AudienceFilter };
    if (cfg.mode !== 'FILTER' && cfg.mode !== 'EXCEL') return null;
    return { mode: cfg.mode, frozen: cfg.frozen === true, filter: cfg.filter };
  }

  /**
   * Load scheme + its roster + enrollment statuses for aggregation.
   *
   * The scheme lookup is platformWide-aware (an un-assumed GIFSY operator resolves
   * ANY tenant's scheme; everyone else is hard-pinned to `user.clientId`). The
   * scheme's OWN `clientId` is then threaded through every downstream tenant-scoped
   * query — so an un-assumed GIFSY read is pinned to the scheme's tenant (no leak),
   * and a tenant caller can never reach a scheme outside its own clientId.
   */
  private async loadAggregation(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...(platformWide(user) ? {} : { clientId: user.clientId }) },
      select: { id: true, code: true, name: true, status: true, audienceConfig: true, clientId: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');
    const { audienceConfig, clientId, ...schemePublic } = scheme;

    const roster = await this.prisma.schemeOutlet.findMany({
      where: { schemeId, clientId },
      select: {
        id: true,
        outletRef: true,
        outletName: true,
        matchedOutletId: true,
        matchedOutlet: {
          select: {
            zone: true,
            programName: true,
            outletType: { select: { name: true } },
          },
        },
      },
    });

    const enrollments = await this.prisma.schemeEnrollment.findMany({
      // Soft-deleted enrollments are excluded from coverage/counts (they read as NOT_ENROLLED).
      where: { schemeId, deletedAt: null },
      select: { schemeOutletId: true, status: true },
    });

    // schemeOutletId → status map, returned so tenantReport reuses it (no second query, B-LOW-4).
    const statusByOutlet = new Map<string, string>();
    for (const e of enrollments) statusByOutlet.set(e.schemeOutletId, e.status);

    const enrolledIds = new Set(enrollments.map((e) => e.schemeOutletId));
    const rosterCount = roster.length;
    const enrolledCount = enrollments.length;
    const submittedCount = enrollments.filter((e) => e.status === 'SUBMITTED').length;
    const rejectedCount = enrollments.filter((e) => e.status === 'REJECTED').length;

    // Coverage denominator (B-MED-2): a LIVE-RULE filter scheme (mode FILTER, not frozen)
    // materializes roster rows lazily — the roster ≈ the enrolled set, so coverage against
    // it is meaningless (always ~100%). Measure it against the count of ELIGIBLE outlets the
    // filter matches instead. EXCEL / FILTER-frozen have a fixed roster → use its count.
    const audience = this.parseAudience(audienceConfig);
    const liveRule = audience?.mode === 'FILTER' && audience.frozen !== true;
    const denominator = liveRule
      ? await this.prisma.outlet.count({
          where: buildOutletWhereFromFilter(clientId, audience?.filter),
        })
      : rosterCount;
    const coveragePct = denominator > 0 ? Math.round((enrolledCount / denominator) * 1000) / 10 : 0;
    const notEnrolledCount = Math.max(denominator - enrolledCount, 0);

    const byZone = tally(
      roster.map((r) => ({ id: r.id, key: r.matchedOutlet?.zone ?? null })),
      enrolledIds,
    );
    const byProgram = tally(
      roster.map((r) => ({ id: r.id, key: r.matchedOutlet?.programName ?? null })),
      enrolledIds,
    );
    const byOutletType = tally(
      roster.map((r) => ({ id: r.id, key: r.matchedOutlet?.outletType?.name ?? null })),
      enrolledIds,
    );

    return {
      scheme: schemePublic,
      roster,
      enrolledIds,
      statusByOutlet,
      // Surfaced so the UI can label WHAT the coverage % is measured against (B-MED-2).
      audienceMode: audience?.mode ?? null,
      frozen: audience?.frozen ?? false,
      coverageDenominator: denominator,
      summary: {
        rosterCount,
        enrolledCount,
        submittedCount,
        rejectedCount,
        notEnrolledCount,
        coveragePct,
      },
      byStatus: {
        SUBMITTED: submittedCount,
        REJECTED: rejectedCount,
        NOT_ENROLLED: rosterCount - enrolledCount,
      },
      byZone,
      byProgram,
      byOutletType,
    };
  }

  /** GIFSY admin report — aggregates + breakdowns (no row list needed here). */
  async gifsyReport(user: JwtPayload, schemeId: string) {
    const a = await this.loadAggregation(user, schemeId);
    return {
      scheme: a.scheme,
      audienceMode: a.audienceMode,
      frozen: a.frozen,
      coverageDenominator: a.coverageDenominator,
      summary: a.summary,
      byStatus: a.byStatus,
      byZone: a.byZone,
      byProgram: a.byProgram,
      byOutletType: a.byOutletType,
    };
  }

  /**
   * Tenant admin read-only report (D26) — the same aggregates plus a per-outlet
   * row list, but NO raw media / formValues inline. Just status + master attrs.
   */
  async tenantReport(user: JwtPayload, schemeId: string) {
    const a = await this.loadAggregation(user, schemeId);
    // Reuse the status map loadAggregation already built (B-LOW-4 — no second query).
    const rows = a.roster.map((r) => ({
      outletRef: r.outletRef,
      outletName: r.outletName,
      matched: !!r.matchedOutletId,
      zone: r.matchedOutlet?.zone ?? null,
      program: r.matchedOutlet?.programName ?? null,
      outletType: r.matchedOutlet?.outletType?.name ?? null,
      status: a.statusByOutlet.get(r.id) ?? 'NOT_ENROLLED',
    }));

    return {
      scheme: a.scheme,
      audienceMode: a.audienceMode,
      frozen: a.frozen,
      coverageDenominator: a.coverageDenominator,
      summary: a.summary,
      byStatus: a.byStatus,
      byZone: a.byZone,
      byProgram: a.byProgram,
      byOutletType: a.byOutletType,
      rows,
    };
  }

  /**
   * Excel export (D25/D30) — one row per roster row with base attributes + one
   * column per form field. Media fields render as auth-gated view links (D30).
   * Tenant-scoped.
   */
  async exportEnrollments(user: JwtPayload, schemeId: string, host = ''): Promise<StreamableFile> {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...(platformWide(user) ? {} : { clientId: user.clientId }) },
      select: { id: true, code: true, clientId: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');
    // Pin every downstream tenant-scoped query to the scheme's OWN tenant (not the
    // caller's), so an un-assumed GIFSY export stays inside the scheme's tenant.
    const clientId = scheme.clientId;

    const roster = await this.prisma.schemeOutlet.findMany({
      where: { schemeId, clientId },
      select: {
        outletRef: true,
        outletName: true,
        matchedOutletId: true,
        // The whole uploaded audience-Excel row (original headers → values) so the
        // export can surface every uploaded variable column (#1).
        prefillValues: true,
        taggedSalesUser: { select: { employeeCode: true } },
        matchedOutlet: {
          select: {
            name: true,
            zone: true,
            programName: true,
            programCategory: true,
            outletType: { select: { name: true } },
          },
        },
        enrollment: {
          select: {
            id: true,
            status: true,
            currentVersion: true,
            formValues: true,
            enrolledAt: true,
            rejectionReason: true,
            deletedAt: true,
            // submittedBy is a User; its 1:1 SalesUser (if any) carries the employeeCode
            // surfaced as "Submitted By (Employee)" — a clean optional relation, not a join.
            submittedBy: { select: { name: true, phone: true, salesUser: { select: { employeeCode: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (roster.length === 0) {
      throw new NotFoundException('No roster entries for this scheme.');
    }

    const form = await this.prisma.schemeEnrollmentForm.findUnique({
      where: { schemeId },
      select: { formSchema: true },
    });
    const fields = this.fieldsFromSchema(form?.formSchema);

    const mapped: ExportRosterRow[] = roster.map((r) => ({
      outletRef: r.outletRef,
      outletName: r.outletName,
      matchedOutletName: r.matchedOutlet?.name ?? null,
      matchedOutletId: r.matchedOutletId,
      zone: r.matchedOutlet?.zone ?? null,
      programName: r.matchedOutlet?.programName ?? null,
      programCategory: r.matchedOutlet?.programCategory ?? null,
      outletType: r.matchedOutlet?.outletType?.name ?? null,
      taggedEmployeeCode: r.taggedSalesUser?.employeeCode ?? null,
      prefillValues: (r.prefillValues as Record<string, unknown> | null) ?? null,
      // The live enrollment id — threaded into the media view-token (null when the row
      // is not enrolled OR soft-deleted, mirroring the enrollment guard below).
      enrollmentId: r.enrollment && r.enrollment.deletedAt == null ? r.enrollment.id : null,
      // A soft-deleted enrollment reads as absent (NOT_ENROLLED) in the export — its captured
      // values must never leak into the xlsx.
      enrollment: r.enrollment && r.enrollment.deletedAt == null
        ? {
            status: r.enrollment.status,
            currentVersion: r.enrollment.currentVersion,
            formValues: r.enrollment.formValues,
            enrolledAt: r.enrollment.enrolledAt,
            rejectionReason: r.enrollment.rejectionReason,
            submittedByName: r.enrollment.submittedBy?.name ?? null,
            submittedByPhone: r.enrollment.submittedBy?.phone ?? null,
            submittedByEmployeeCode: r.enrollment.submittedBy?.salesUser?.employeeCode ?? null,
          }
        : null,
    }));

    const { rows, columns } = buildEnrollmentExportRows(mapped, fields, (enrollmentId, fieldId) =>
      this.mediaViewLink(enrollmentId, clientId, fieldId, host),
    );

    // Second sheet: a legend documenting where every column's value comes from.
    const legendRows = columns.map((c) => ({ Column: c.name, Source: c.source }));
    const buffer = buildXlsx([
      { name: 'Enrollments', rows },
      { name: 'Columns', rows: legendRows },
    ]);
    const filename = `scheme_${scheme.code}_enrollments_${new Date().toISOString().split('T')[0]}.xlsx`;

    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** Defensive parse of the stored form schema → an ordered FormField[]. */
  private fieldsFromSchema(schema: unknown): FormField[] {
    const fields = (schema as EnrollmentFormSchema | undefined)?.fields;
    if (!Array.isArray(fields)) return [];
    return [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
}
