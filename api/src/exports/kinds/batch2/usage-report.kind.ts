/**
 * Usage Report → "Export Excel" — GET /v1/reports/usage?format=xlsx (owner-approved 2026-11-18).
 *
 * EVERY row of the filtered, sorted list the page shows (not just the visible page), built by the SAME
 * buildUsageReport the JSON endpoint uses (reports/usage/usage-report.ts), so page and file never disagree.
 * Scope: the caller's JWT clientId only (see usage-report.ts). One row per user — a tenant's users (≈ 9k for Bajaj)
 * from one grouped SQL aggregate → light → always streams instantly.
 *
 * A second sheet, "About", carries the duration note and the tracking start date (same wording as the page).
 *
 * Personal data (names + mobile numbers) leaves the system → exactly like the installed-users export:
 *   • 0 rows → 404 "0 users matched these filters." (no file, no audit row);
 *   • otherwise ONE AuditLog row (action EXPORT, entityType USAGE_REPORT: who, tenant, row count, filters) is written
 *     BEFORE the workbook — an audit failure fails the request before any byte is sent.
 */
import { NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell } from '../../../common/ist-date';
import { normalizePhoneLast10 } from '../../../common/partner-group.helper';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { UsageReportQueryDto } from '../../../reports/dto/usage-report.dto';
import {
  buildUsageReport,
  requireUsageTenant,
  resolveUsageParams,
  USAGE_DURATION_NOTE,
  USAGE_REGION_NOTE,
  type UsageParams,
  type UsageReport,
  type UsageRow,
} from '../../../reports/usage/usage-report';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { parseQueryDto } from './kind-support';

/** 'ASM' is the default header — the file uses the tenant's own ASM level name (usageReportHeaders). */
export const USAGE_REPORT_HEADERS = [
  'Name',
  'Mobile',
  'Role',
  'ASM',
  'Zone',
  'State',
  'City',
  'Status',
  'Programme',
  'Region',
  'Days active',
  'Visits',
  'Minutes (at least)',
  'Avg minutes per tracked day',
  'App days',
  'Browser days',
  'Phone / computer',
  'First seen (IST)',
  'Last seen (IST)',
] as const;

export function usageReportHeaders(asmHeader: string): string[] {
  return USAGE_REPORT_HEADERS.map((h) => (h === 'ASM' ? asmHeader : h));
}

export const USAGE_REPORT_NONE_MESSAGE = '0 users matched these filters.';
export const USAGE_ABOUT_SHEET = 'About';

/** The notes sheet: duration rule, tracking start date, programme/region rule, range, filters, totals basis. */
export function usageAboutRows(report: UsageReport, p: UsageParams, now: Date): XlsxCell[][] {
  return [
    ['Date range (IST)', `${report.range.from} to ${report.range.to} (${report.range.days} days)`],
    ['Duration', `${USAGE_DURATION_NOTE} Shown as "Minutes (at least)"; visit boundaries are accurate to about ±1 minute.`],
    [
      'Tracking started on',
      report.trackingStartedOn
        ? `${report.trackingStartedOn} — earlier days count as active days but have no duration or medium.`
        : 'No tracked activity yet — all days count as active days only (no duration or medium).',
    ],
    ['Programme / region', USAGE_REGION_NOTE],
    [report.asmHeader, report.notes.area[0] ?? ''],
    ['Zone / State / City', report.notes.area[1] ?? ''],
    ['Not set / Not in hierarchy', report.notes.area[2] ?? ''],
    ['Avg minutes per tracked day', 'Minutes ÷ days with tracking (days before tracking started are left out).'],
    ['Phone / computer', 'From the browser identity. Tablets count as phones; an iPad asking for the desktop site counts as a computer.'],
    ['Background activity', 'Automatic refreshes (notification bell, download badge, status polling) are not counted — only real actions.'],
    [
      'Filters',
      [
        p.role ? `role ${p.role}` : 'all roles',
        p.program ? `programme ${p.program}` : 'all programmes',
        p.region ? `region ${p.region}` : 'all regions',
        p.includeInactive ? 'includes users with no activity in this range' : 'users with activity only',
      ].join(' · '),
    ],
    ['Generated (IST)', istDateTimeCell(now)],
  ];
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended',
  PENDING_VERIFICATION: 'Pending verification',
};

export function usageReportCells(r: UsageRow): XlsxCell[] {
  return [
    r.name,
    normalizePhoneLast10(r.phone) ?? r.phone ?? '',
    r.role.replace(/_/g, ' '),
    r.asm,
    r.zone,
    r.state,
    r.city,
    STATUS_LABEL[r.status] ?? r.status,
    r.programmes.join(', '),
    r.regions.join(', '),
    r.daysActive,
    r.visits,
    r.minutes,
    r.avgMinutesPerDay ?? '',
    r.appDays,
    r.browserDays,
    r.device,
    r.firstSeenAt ? istDateTimeCell(new Date(r.firstSeenAt)) : '',
    r.lastSeenAt ? istDateTimeCell(new Date(r.lastSeenAt)) : '',
  ];
}

async function run(ctx: ExportRunContext, p: UsageParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = requireUsageTenant(ctx.user?.clientId);
  // 1. Build every row first — nothing written yet.
  const report = await buildUsageReport(ctx.prisma, clientId, p, ctx.now);
  if (!report.rows.length) throw new NotFoundException(USAGE_REPORT_NONE_MESSAGE);

  // 2. Audit BEFORE any byte leaves.
  await ctx.prisma.auditLog.create({
    data: {
      action: 'EXPORT',
      entityType: 'USAGE_REPORT',
      entityId: clientId,
      actorId: ctx.user.sub,
      metadata: {
        route: 'reports/usage',
        clientId,
        assumed: !!ctx.user.assumed,
        actorRole: ctx.user.role,
        rowCount: report.rows.length,
        filters: {
          from: p.from,
          to: p.to,
          role: p.role,
          program: p.program,
          region: p.region,
          sort: p.sort,
          includeInactive: p.includeInactive,
        },
      },
    },
  });

  // 3. Only now write the workbook.
  const sheet = await out.addSheet('Usage', usageReportHeaders(report.asmHeader), {
    widths: [26, 14, 16, 24, 16, 18, 18, 12, 22, 22, 11, 9, 12, 14, 10, 12, 14, 18, 18],
  });
  for (const r of report.rows) await sheet.addRow(usageReportCells(r));

  // 4. "About this report": how to read the numbers (same wording as the page). Not counted as data rows.
  const about = await out.addSheet(USAGE_ABOUT_SHEET, ['About this report', ''], { widths: [28, 110] });
  for (const line of usageAboutRows(report, p, ctx.now)) await about.addRow(line);
  return { rowCount: report.rows.length };
}

export const USAGE_REPORT_KIND: ExportKindDef<UsageParams> = {
  kind: 'usage-report',
  label: 'Usage report',
  // Same as GET /v1/reports/usage (and the Session Report): @Roles('GIFSY_ADMIN','MIS_USER','CLIENT_ADMIN') + reports:read.
  access: { roles: ['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN'], permission: 'reports:read' },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(UsageReportQueryDto, raw);
    requireUsageTenant(user?.clientId); // fail closed at request time (403, never queued)
    return resolveUsageParams(q);
  },
  isHeavy: () => false,
  describeParams: (p) =>
    [
      `${p.from} to ${p.to}`,
      p.role ? p.role.replace(/_/g, ' ') : 'all roles',
      p.program ? `programme ${p.program}` : null,
      p.region ? `region ${p.region}` : null,
      p.includeInactive ? 'incl. inactive users' : 'active users only',
    ]
      .filter(Boolean)
      .join(' · '),
  fileName: (p) => `usage-report-${p.from}-to-${p.to}.xlsx`,
  run,
};
