import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildXlsx } from '../common/xlsx';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { EnrollmentFormSchema, FormField } from './enrollment-form.helper';
import { AudienceFilter, buildOutletWhereFromFilter } from './scheme-roster.helper';

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
 *   - media field (key present)  → an auth-gated view link via `mintLink`
 *   - GPS_POINT ({lat,lng,...})   → "lat, lng (±acc)"
 *   - array (multi-select)        → comma-joined
 *   - object                      → JSON
 *   - primitive                   → String()
 * Null/undefined/'' → ''. Injection-safety is applied downstream by buildXlsx
 * (jsonToSheetSafe/cellSafe on every string cell), so callers pass raw strings.
 */
export function renderExportValue(
  field: FormField,
  value: unknown,
  mintLink: (mediaKey: string) => string,
): string {
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
    return key ? mintLink(key) : '';
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
  mintLink: (mediaKey: string) => string,
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

  // UNION of every row's uploaded-Excel columns (first-seen order), de-collided
  // against the reserved headers. `origKey` reads the value, `header` names the column.
  const excelCols: { origKey: string; header: string }[] = [];
  const excelSeen = new Set<string>();
  for (const r of roster) {
    const pv = r.prefillValues;
    if (!pv || typeof pv !== 'object' || Array.isArray(pv)) continue;
    for (const origKey of Object.keys(pv)) {
      if (excelSeen.has(origKey)) continue;
      excelSeen.add(origKey);
      excelCols.push({ origKey, header: reserved.has(origKey) ? `${origKey} (Excel)` : origKey });
    }
  }

  const rows = roster.map((r) => {
    const values = (r.enrollment?.formValues ?? {}) as Record<string, unknown>;
    const pv = (r.prefillValues ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    // Identity
    row['Outlet Ref'] = r.outletRef;
    // Outlet Name: uploaded name if non-empty, else the matched outlet's real name, else ''.
    row['Outlet Name'] = r.outletName?.trim() ? r.outletName : r.matchedOutletName ?? '';
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
    // Captured form values
    for (const f of fields) {
      row[columnFor.get(f.id) as string] = renderExportValue(f, values[f.id], mintLink);
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The auth-gated, SESSION-authenticated media view path for the D30 export
   * links — identical to the enrollment stream's `extractMedia` viewPath
   * (scheme-enrollment.service.ts). This is NOT a self-authenticating token:
   * whoever opens the link must still present a valid session, and
   * SchemeEnrollmentController's `GET :id/enrollments/media` enforces the tenant
   * from the object key's tenant folder (`scheme-media/<clientId>/…`).
   */
  private mediaViewLink(mediaKey: string, schemeId: string, host: string): string {
    // App-PROXY path (/api/… → backend /v1/…). Made ABSOLUTE against the tenant host
    // the admin downloaded from (resolved by the controller, see exportEnrollments)
    // so the link is clickable from a .xlsx opened outside the browser and points
    // back to the right tenant. No host → proxy-relative (still the correct path).
    const path = `/api/schemes/${schemeId}/enrollments/media?key=${encodeURIComponent(mediaKey)}`;
    return host ? `https://${host}${path}` : path;
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

    const { rows, columns } = buildEnrollmentExportRows(mapped, fields, (key) =>
      this.mediaViewLink(key, schemeId, host),
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
