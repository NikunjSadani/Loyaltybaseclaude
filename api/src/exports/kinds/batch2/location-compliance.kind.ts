/**
 * Location-compliance report → "Export Excel" — GET /v1/reports/location-compliance?format=xlsx (owner-approved
 * 2026-11-18, platform/docs/plans/LOCATION-GATE.md).
 *
 * EVERY row of the filtered, sorted list the page shows, built by the SAME buildLocationReport the JSON endpoint uses,
 * so page and file never disagree. One row per rep with activity — light → always streams.
 * Sheets: "Location" (rows + a TOTAL row) and "About" (how to read each column, the setting state, filters).
 *
 * Names + mobile numbers leave the system → exactly like the Usage report: 0 rows → 404 (no file, no audit row);
 * otherwise ONE AuditLog row (EXPORT / LOCATION_COMPLIANCE_REPORT) BEFORE any byte.
 */
import { NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell } from '../../../common/ist-date';
import { normalizePhoneLast10 } from '../../../common/partner-group.helper';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { LocationComplianceQueryDto } from '../../../reports/dto/location-compliance.dto';
import {
  buildLocationReport,
  LOCATION_NOTES,
  locationSwitchedOffBanner,
  requireLocationTenant,
  resolveLocationParams,
  type LocationParams,
  type LocationReport,
  type LocationRow,
  type LocationTotals,
} from '../../../reports/location/location-compliance-report';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { parseQueryDto } from './kind-support';

export const LOCATION_REPORT_HEADERS = [
  'Name',
  'Mobile',
  'Role',
  'Region',
  'KYCs',
  'Visibility captures',
  'No GPS',
  'Accuracy worse than 50 m',
  'Flagged unverifiable',
  'Blocked outside fence',
  'Median accuracy (m)',
  'Median KYC lock time (s)',
] as const;

export const LOCATION_REPORT_NONE_MESSAGE = '0 reps matched these filters.';
export const LOCATION_ABOUT_SHEET = 'About';

const secs = (ms: number | null) => (ms == null ? '' : Math.round(ms / 100) / 10);

export function locationReportCells(r: LocationRow): XlsxCell[] {
  return [
    r.name,
    normalizePhoneLast10(r.phone) ?? r.phone ?? '',
    r.role.replace(/_/g, ' '),
    r.regions.join(', '),
    r.kycs,
    r.visibilityCaptures,
    r.noGps,
    r.poorAccuracy,
    r.unverifiable,
    r.blockedOutside,
    r.medianAccuracyM ?? '',
    secs(r.medianLockMs),
  ];
}

export function locationTotalCells(t: LocationTotals): XlsxCell[] {
  return [
    `TOTAL (${t.reps} reps)`,
    '',
    '',
    '',
    t.kycs,
    t.visibilityCaptures,
    t.noGps,
    t.poorAccuracy,
    t.unverifiable,
    t.blockedOutside,
    t.medianAccuracyM ?? '',
    secs(t.medianLockMs),
  ];
}

export function locationAboutRows(report: LocationReport, p: LocationParams, now: Date): XlsxCell[][] {
  return [
    ['Date range (IST)', `${report.range.from} to ${report.range.to} (${report.range.days} days)`],
    [
      'Require location',
      report.setting.requireLocation
        ? 'ON — reps cannot start or submit a KYC or visibility capture without a location fix.'
        : locationSwitchedOffBanner(report.setting.switchedOffSince),
    ],
    ['What is counted', LOCATION_NOTES.sources],
    ['Accuracy', LOCATION_NOTES.accuracy],
    ['Flagged unverifiable', LOCATION_NOTES.unverifiable],
    ['Blocked outside fence', LOCATION_NOTES.blocked],
    ['Median KYC lock time', LOCATION_NOTES.lock],
    ['Region', LOCATION_NOTES.region],
    [
      'Filters',
      [p.role ? `role ${p.role}` : 'all sales roles', p.region ? `region ${p.region}` : 'all regions', 'reps with activity only'].join(
        ' · ',
      ),
    ],
    ['Generated (IST)', istDateTimeCell(now)],
  ];
}

async function run(ctx: ExportRunContext, p: LocationParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = requireLocationTenant(ctx.user?.clientId);
  const report = await buildLocationReport(ctx.prisma, clientId, p, ctx.now);
  if (!report.rows.length) throw new NotFoundException(LOCATION_REPORT_NONE_MESSAGE);

  await ctx.prisma.auditLog.create({
    data: {
      action: 'EXPORT',
      entityType: 'LOCATION_COMPLIANCE_REPORT',
      entityId: clientId,
      actorId: ctx.user.sub,
      metadata: {
        route: 'reports/location-compliance',
        clientId,
        assumed: !!ctx.user.assumed,
        actorRole: ctx.user.role,
        rowCount: report.rows.length,
        filters: { from: p.from, to: p.to, role: p.role, region: p.region, sort: p.sort },
      },
    },
  });

  const sheet = await out.addSheet('Location', [...LOCATION_REPORT_HEADERS], {
    widths: [26, 14, 16, 22, 8, 12, 9, 14, 12, 12, 12, 14],
  });
  for (const r of report.rows) await sheet.addRow(locationReportCells(r));
  await sheet.addRow(locationTotalCells(report.totals));

  const about = await out.addSheet(LOCATION_ABOUT_SHEET, ['About this report', ''], { widths: [28, 110] });
  for (const line of locationAboutRows(report, p, ctx.now)) await about.addRow(line);
  return { rowCount: report.rows.length };
}

export const LOCATION_COMPLIANCE_KIND: ExportKindDef<LocationParams> = {
  kind: 'location-compliance',
  label: 'Location-compliance report',
  // Same as GET /v1/reports/location-compliance (and the Usage report): GIFSY_ADMIN / MIS_USER / CLIENT_ADMIN + reports:read.
  access: { roles: ['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN'], permission: 'reports:read' },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(LocationComplianceQueryDto, raw);
    requireLocationTenant(user?.clientId);
    return resolveLocationParams(q);
  },
  isHeavy: () => false,
  describeParams: (p) =>
    [`${p.from} to ${p.to}`, p.role ? p.role.replace(/_/g, ' ') : 'all sales roles', p.region ? `region ${p.region}` : null]
      .filter(Boolean)
      .join(' · '),
  fileName: (p) => `location-compliance-${p.from}-to-${p.to}.xlsx`,
  run,
};
