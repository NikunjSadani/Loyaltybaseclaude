/**
 * Visibility status report (xlsx) as a background export — kind `visibility-status`, served by
 * `GET /v1/reports/visibility-status?format=xlsx[&dateFrom&dateTo]`. The JSON format of the same endpoint stays in
 * ReportsService and uses the SAME select + row mapper below, so the two never drift.
 *
 * Over-fetch fix: an explicit select of the 12 columns' sources (was `include` with no select = every capture column
 * incl. the `formValues` JSON). Paged ≤ 2,000 rows, keyset on (createdAt DESC, id DESC) — the old order.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { istDateKey, istDayRangeFilter } from '../../../common/ist-date';
import { platformWide } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TenantService } from '../../../tenant/tenant.service';
import { visibilityStatusWords } from '../../../visibility/visibility-report-labels';
import type { ExportKindDef } from '../../export-kinds';
import { BATCH1_PAGE_SIZE, describeRange, isBoundedRange, optionalString, rawObject } from './common';

export const VISIBILITY_STATUS_SELECT = {
  id: true,
  outletCode: true,
  outletName: true,
  windowKey: true,
  status: true,
  captureLat: true,
  captureLng: true,
  geoFenceOk: true,
  createdAt: true,
  outlet: { select: { name: true, city: true } },
  submittedBy: { select: { user: { select: { name: true } } } },
} satisfies Prisma.VisibilityCaptureSelect;

export type VisibilityStatusCapture = Prisma.VisibilityCaptureGetPayload<{ select: typeof VISIBILITY_STATUS_SELECT }>;

/** One report row; `serial` is the 1-based S.No. */
export function visibilityStatusRow(s: VisibilityStatusCapture, serial: number) {
  return {
    'S.No': serial,
    'Capture ID': s.id,
    'Outlet Code': s.outletCode,
    'Outlet Name': s.outlet?.name ?? s.outletName,
    City: s.outlet?.city ?? '',
    Window: s.windowKey,
    // Plain words (2026-11-20, same words as the Visibility report): Waiting for review / Approved / Needs re-take / Rejected.
    Status: visibilityStatusWords(s.status),
    'Captured By': s.submittedBy?.user?.name ?? '',
    Latitude: s.captureLat?.toString() ?? '',
    Longitude: s.captureLng?.toString() ?? '',
    'Geo-fence': s.geoFenceOk === null ? 'unverifiable' : s.geoFenceOk ? 'ok' : 'outside',
    'Submitted On': istDateKey(s.createdAt),
  };
}

/** The report's base filter: the tenant + the optional IST-day createdAt range. */
export function visibilityStatusWhere(clientId: string, dateFrom?: string, dateTo?: string): Prisma.VisibilityCaptureWhereInput {
  const where: Prisma.VisibilityCaptureWhereInput = { clientId };
  const createdAt = istDayRangeFilter(dateFrom, dateTo);
  if (createdAt) where.createdAt = createdAt;
  return where;
}

/**
 * The master Visibility gate: 403 for the tenant's own users when the switch is OFF; the GIFSY operator is exempt only
 * in true platform context (un-assumed).
 */
export async function assertVisibilityStatusEnabled(tenant: TenantService, user: JwtPayload): Promise<void> {
  if (platformWide(user)) return;
  if (!(await tenant.resolveVisibilityEnabled(user.clientId))) {
    throw new ForbiddenException('Visibility is not enabled for this tenant.');
  }
}

export interface VisibilityStatusParams {
  dateFrom?: string;
  dateTo?: string;
}

/** The header row — the keys of visibilityStatusRow, in order (pinned by the parity spec). */
export const VISIBILITY_STATUS_HEADERS = [
  'S.No', 'Capture ID', 'Outlet Code', 'Outlet Name', 'City', 'Window', 'Status', 'Captured By', 'Latitude',
  'Longitude', 'Geo-fence', 'Submitted On',
] as const;

/**
 * Heavy rule: light only for a bounded range of ≤ 1 month (both dates given); open-ended / "all" → heavy (~51k Bajaj
 * captures). Access mirrors the endpoint: @Roles('GIFSY_ADMIN', 'MIS_USER') + @RequirePermission('reports:read').
 */
export const VISIBILITY_STATUS_KIND: ExportKindDef<VisibilityStatusParams> = {
  kind: 'visibility-status',
  label: 'Visibility status report',
  access: { roles: ['GIFSY_ADMIN', 'MIS_USER'], permission: 'reports:read' },
  parseParams(raw) {
    const r = rawObject(raw);
    const dateFrom = optionalString(r, 'dateFrom');
    const dateTo = optionalString(r, 'dateTo');
    return { ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) };
  },
  isHeavy: (p) => !isBoundedRange(p.dateFrom, p.dateTo),
  describeParams: (p) => describeRange(p.dateFrom, p.dateTo),
  fileName: () => 'visibility-status.xlsx',
  async run(ctx, params, out) {
    await assertVisibilityStatusEnabled(ctx.moduleRef.get(TenantService, { strict: false }), ctx.user);
    const base = visibilityStatusWhere(ctx.clientId, params.dateFrom, params.dateTo);
    let sheet: Awaited<ReturnType<typeof out.addSheet>> | null = null;
    let serial = 0;
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page = await ctx.prisma.visibilityCapture.findMany({
        where: after
          ? { AND: [base, { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] }
          : base,
        select: VISIBILITY_STATUS_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BATCH1_PAGE_SIZE,
      });
      if (page.length === 0) break;
      const last = page[page.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
      sheet ??= await out.addSheet('Visibility Status', VISIBILITY_STATUS_HEADERS);
      for (const s of page) {
        const row = visibilityStatusRow(s, ++serial);
        await sheet.addRow(VISIBILITY_STATUS_HEADERS.map((h) => row[h]));
      }
      if (page.length < BATCH1_PAGE_SIZE) break;
    }
    // No rows → the old file was a blank sheet without a header row (json_to_sheet of []); kept identical.
    if (!sheet) sheet = await out.addSheet('Visibility Status', []);
    return { rowCount: sheet.rowCount };
  },
};
