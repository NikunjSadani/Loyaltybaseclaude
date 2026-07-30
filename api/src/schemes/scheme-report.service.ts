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
  matchedOutletId: string | null;
  zone: string | null;
  programName: string | null;
  programCategory: string | null;
  outletType: string | null;
  taggedEmployeeCode: string | null;
  enrollment: {
    status: string;
    currentVersion: number;
    formValues: unknown;
    enrolledAt: Date;
    rejectionReason: string | null;
    submittedByName: string | null;
    submittedByPhone: string | null;
  } | null;
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
 * Build the export rows (pure). Every row has an IDENTICAL key set — the fixed
 * base columns plus one column per form field — so buildXlsx (which derives the
 * header from the FIRST row's keys) never drops a column when the first roster
 * row has no enrollment. Media fields become auth-gated links via `mintLink`.
 */
export function buildEnrollmentExportRows(
  roster: ExportRosterRow[],
  fields: FormField[],
  mintLink: (mediaKey: string) => string,
): Record<string, unknown>[] {
  // De-collide duplicate field labels so no column silently overwrites another.
  const seen = new Map<string, number>();
  const columnFor = new Map<string, string>(); // fieldId → column header
  for (const f of fields) {
    const base = f.label?.trim() || f.id;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    columnFor.set(f.id, n === 1 ? base : `${base} (${n})`);
  }

  return roster.map((r) => {
    const values = (r.enrollment?.formValues ?? {}) as Record<string, unknown>;
    const row: Record<string, unknown> = {
      'Outlet Ref': r.outletRef,
      'Outlet Name': r.outletName,
      Matched: r.matchedOutletId ? 'Yes' : 'No',
      Zone: r.zone ?? '',
      Program: r.programName ?? '',
      'Program Category': r.programCategory ?? '',
      'Outlet Type': r.outletType ?? '',
      'Tagged Employee': r.taggedEmployeeCode ?? '',
      Status: r.enrollment?.status ?? 'NOT_ENROLLED',
      Version: r.enrollment?.currentVersion ?? '',
      'Enrolled At': r.enrollment ? r.enrollment.enrolledAt.toISOString() : '',
      'Submitted By': r.enrollment?.submittedByName ?? '',
      'Submitted By Phone': r.enrollment?.submittedByPhone ?? '',
      'Rejection Reason': r.enrollment?.rejectionReason ?? '',
    };
    for (const f of fields) {
      row[columnFor.get(f.id) as string] = renderExportValue(f, values[f.id], mintLink);
    }
    return row;
  });
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
  private mediaViewLink(mediaKey: string, schemeId: string): string {
    // App-PROXY path (/api/… → backend /v1/…), and fully-qualified when
    // PUBLIC_APP_BASE_URL is set so the link is clickable from a downloaded .xlsx
    // opened outside the browser. Env unset → proxy-relative (still the correct path).
    const base = (process.env.PUBLIC_APP_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}/api/schemes/${schemeId}/enrollments/media?key=${encodeURIComponent(mediaKey)}`;
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
  async exportEnrollments(user: JwtPayload, schemeId: string): Promise<StreamableFile> {
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
        taggedSalesUser: { select: { employeeCode: true } },
        matchedOutlet: {
          select: {
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
            submittedBy: { select: { name: true, phone: true } },
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
      matchedOutletId: r.matchedOutletId,
      zone: r.matchedOutlet?.zone ?? null,
      programName: r.matchedOutlet?.programName ?? null,
      programCategory: r.matchedOutlet?.programCategory ?? null,
      outletType: r.matchedOutlet?.outletType?.name ?? null,
      taggedEmployeeCode: r.taggedSalesUser?.employeeCode ?? null,
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
          }
        : null,
    }));

    const rows = buildEnrollmentExportRows(mapped, fields, (key) =>
      this.mediaViewLink(key, schemeId),
    );

    const buffer = buildXlsx([{ name: 'Enrollments', rows }]);
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
