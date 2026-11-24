import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportFormat, ReportRangeQueryDto, TdsReportQueryDto } from './dto/reports.dto';
import { buildXlsx, ReportSheet } from '../common/xlsx';
import { istDayRangeFilter, istDateKey } from '../common/ist-date';
import {
  VISIBILITY_STATUS_SELECT,
  assertVisibilityStatusEnabled,
  visibilityStatusRow,
  visibilityStatusWhere,
} from '../exports/kinds/batch1/visibility-status';
import { KYC_STATUS_OUTLET_SELECT, kycStatusRows, kycStatusRoutingEnabled } from '../exports/kinds/batch1/kyc-status';
import { UsageReportQueryDto } from './dto/usage-report.dto';
import { buildUsageReport, pageOfUsageReport, resolveUsageParams } from './usage/usage-report';
import { LocationComplianceQueryDto } from './dto/location-compliance.dto';
import { isLocationRequired } from '../common/location-gate.helper';
import { buildLocationReport, pageOfLocationReport, resolveLocationParams } from './location/location-compliance-report';
import { RedemptionReportQueryDto } from './dto/redemption-report.dto';
import { redemptionOrderCount, redemptionScreenSummary, type RedemptionScreenSummary } from './redemptions/redemption-report.summary';
import { loadUserAreaResolver, type AreaPrisma, type UserAreaResolver } from './area/user-area';
import { tenantInstallWhere } from '../push/pwa-adoption.service';
import {
  installedUsersIdHeaders,
  levelIdAboutRows,
  platformLabels,
} from '../exports/kinds/batch2/app-installed-users.kind';

/** Session Report fixed headers (Excel). The App Installed + level-ID columns sit between Role and Last Login. */
export const SESSION_REPORT_LEAD_HEADERS = ['S.No', 'Name', 'Mobile', 'Role'] as const;
export const SESSION_REPORT_APP_HEADER = 'App Installed';
export const SESSION_REPORT_LAST_LOGIN_HEADER = 'Last Login';

/** "Yes — Android, iOS" / "No" — the Session Report's App Installed cell (screen + Excel). */
export function appInstalledCell(platforms: readonly string[]): string {
  return platforms.length ? `Yes — ${platforms.join(', ')}` : 'No';
}

/** About-sheet note for the App Installed column. */
export const SESSION_REPORT_APP_NOTE =
  '"Yes — <platforms>" = the user has opened the app as an installed (home-screen) app on those platforms — the same ' +
  'users counted as "Installed to home screen" on the App Adoption page. "No" = never opened as an installed app ' +
  '(they may still use it in the browser).';
export const SESSION_REPORT_ACTIVE_NOTE =
  'Month columns: the number of days the user actually used the app in that month (not logins). Active-day tracking ' +
  'began when the feature shipped, so months before that read 0 (no historical backfill).';

/**
 * Reporting & Analytics — ported from platform/src/app/api/reports/*.
 * Every query is tenant-scoped by clientId (from the session-bound JWT). Each
 * report exposes a single GET that returns JSON by default, or — when
 * ?format=xlsx — an xlsx buffer that the controller streams as a download.
 *
 * The role gate (GIFSY_ADMIN | MIS_USER) and reports:* permission live on the
 * controller; the service preserves the exact filters, row mapping, and
 * aggregations from the Next routes.
 *
 * SKIPPED: billing-trends — its only data source is SalesInvoice, a dropped
 * (World-A) model. See report notes.
 */

/** Discriminated result: JSON payload, or an xlsx buffer to stream. */
export type ReportResult =
  | { kind: 'json'; data: unknown }
  | { kind: 'xlsx'; buffer: Buffer; filename: string };

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * Parses an optional ISO date string to a Date, mirroring `new Date(...)`.
   * ONLY used by schemePerformance to filter the Scheme's own DAY-GRANULAR
   * startDate/endDate columns (both sides day-granular → no IST-day skew). Every
   * report that filters an event TIMESTAMP (createdAt) instead uses
   * `istDayRangeFilter`, which expands a date-only bound to the full inclusive
   * IST day so a `<input type="date">` value neither skews the start (+5:30h) nor
   * truncates the last IST day.
   */
  private parseDate(v?: string): Date | undefined {
    return v ? new Date(v) : undefined;
  }

  private toJson(data: unknown): ReportResult {
    return { kind: 'json', data };
  }

  private toXlsx(sheets: ReportSheet[], filename: string): ReportResult {
    return { kind: 'xlsx', buffer: buildXlsx(sheets), filename };
  }

  // ── Visibility Status ───────────────────────────────────────────────────────
  /** The report's master Visibility gate (403 when OFF; un-assumed Gifsy exempt) — also run before the xlsx export. */
  async assertVisibilityStatusAllowed(user: JwtPayload): Promise<void> {
    await assertVisibilityStatusEnabled(this.tenant, user);
  }

  /**
   * JSON format only — `format=xlsx` is the `visibility-status` export kind (exports/kinds/batch1/visibility-status.ts),
   * routed by the controller. Same select + row mapper as the kind, so the two never drift.
   */
  async visibilityStatus(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    await this.assertVisibilityStatusAllowed(user);
    // Visibility (POSM) captures are keyed by (outlet, window); clientId is a direct column.
    const submissions = await this.prisma.visibilityCapture.findMany({
      where: visibilityStatusWhere(user.clientId, q.dateFrom, q.dateTo),
      select: VISIBILITY_STATUS_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const data = submissions.map((s, i) => visibilityStatusRow(s, i + 1));
    return this.toJson({ data, recordCount: data.length });
  }

  // ── Scheme Performance ────────────────────────────────────────────────────────
  async schemePerformance(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    const dateFrom = this.parseDate(q.dateFrom);
    const dateTo = this.parseDate(q.dateTo);

    const schemes = await this.prisma.scheme.findMany({
      where: {
        deletedAt: null,
        clientId: user.clientId,
        ...(dateFrom && { startDate: { gte: dateFrom } }),
        ...(dateTo && { endDate: { lte: dateTo } }),
      },
      include: {
        _count: { select: { eligibility: true, pointsLedger: true } },
      },
    });

    const data = schemes.map((s, i) => {
      // Total Target / Achievement % depended on the dropped Target model
      // (targetValuePaise / targetPoints / TargetAchievement). Those fields do
      // not exist on the canonical schema, so the aggregation is reported as 0,
      // exactly as the source route already hardcoded achievement to 0.
      const totalTarget = 0;
      const achievementPct = 0;

      return {
        'S.No': i + 1,
        'Scheme ID': s.id,
        'Scheme Name': s.name,
        'Scheme Type': s.schemeType,
        'Reward Type': s.rewardType,
        'Start Date': s.startDate.toISOString().split('T')[0],
        'End Date': s.endDate.toISOString().split('T')[0],
        'Eligible Partners': s._count.eligibility,
        'Total Target (paise)': totalTarget,
        'Achievement %': achievementPct,
        Status: s.status,
      };
    });

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx([{ name: 'Scheme Performance', rows: data }], 'scheme-performance.xlsx');
    }
    return this.toJson({ data, recordCount: data.length });
  }

  // ── TDS Report ───────────────────────────────────────────────────────────────
  async tds(user: JwtPayload, q: TdsReportQueryDto): Promise<ReportResult> {
    const financialYear = q.fy ?? undefined;

    const where: Prisma.TdsRecordWhereInput = {
      payoutTransaction: { batch: { clientId: user.clientId } },
    };
    if (financialYear) where.assessmentYear = financialYear;
    const createdAt = istDayRangeFilter(q.dateFrom, q.dateTo);
    if (createdAt) where.createdAt = createdAt;

    const records = await this.prisma.tdsRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // PAN-level aggregation
    const panSummary: Record<string, { pan: string; tdsPaise: number; count: number }> = {};
    for (const r of records) {
      const pan = r.panNumber ?? 'NO_PAN';
      if (!panSummary[pan]) {
        panSummary[pan] = { pan, tdsPaise: 0, count: 0 };
      }
      panSummary[pan].tdsPaise += Number(r.tdsPaise);
      panSummary[pan].count++;
    }

    const data = records.map((r, i) => ({
      'S.No': i + 1,
      PAN: r.panNumber ?? 'N/A',
      'Partner ID': r.partnerId,
      'Assessment Year': r.assessmentYear ?? '',
      'Quarter Period': r.quarterPeriod ?? '',
      'TDS Rate %': (Number(r.tdsRate) * 100).toFixed(1),
      'TDS Amount (₹)': (Number(r.tdsPaise) / 100).toFixed(2),
      Date: istDateKey(r.createdAt),
    }));

    const panData = Object.values(panSummary).map((p) => ({
      PAN: p.pan,
      'Transaction Count': p.count,
      'Total TDS (₹)': (p.tdsPaise / 100).toFixed(2),
    }));

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx(
        [
          { name: 'TDS Transactions', rows: data },
          { name: 'PAN Summary', rows: panData },
        ],
        'tds-report.xlsx',
      );
    }
    return this.toJson({ data, panSummary: panData, recordCount: data.length });
  }

  // ── Payout Liability ──────────────────────────────────────────────────────────
  async payoutLiability(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    const where: Prisma.PayoutTransactionWhereInput = {
      status: 'PENDING',
      batch: { clientId: user.clientId },
    };
    const createdAt = istDayRangeFilter(q.dateFrom, q.dateTo);
    if (createdAt) where.createdAt = createdAt;

    const transactions = await this.prisma.payoutTransaction.findMany({
      where,
      include: {
        partner: { select: { businessName: true } },
        batch: { select: { batchCode: true } },
      },
      orderBy: { amountPaise: 'desc' },
    });

    const totalLiabilityPaise = transactions.reduce((sum, t) => sum + Number(t.amountPaise), 0);

    const data = transactions.map((t, i) => ({
      'S.No': i + 1,
      'Partner Name': t.partner?.businessName ?? '',
      'Batch Code': t.batch?.batchCode ?? '',
      'Amount (₹)': (Number(t.amountPaise) / 100).toFixed(2),
      Mode: t.payoutMode,
      Status: t.status,
      'Created On': istDateKey(t.createdAt),
    }));

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx([{ name: 'Payout Liability', rows: data }], 'payout-liability.xlsx');
    }
    return this.toJson({
      data,
      recordCount: data.length,
      totalLiability: totalLiabilityPaise / 100,
    });
  }

  // ── Session Report ──────────────────────────────────────────────────────────────
  /**
   * Session Report — every tenant user in rows, last-login timestamp, and active-day
   * counts per month across a 13-month window (the last 12 months + the current
   * month). An "active day" = a UserActivityDay row (the user made >=1 authenticated
   * request on that IST calendar day). `activityDate` is stored as an IST calendar
   * day with no time component, so grouping by its year-month yields IST months
   * directly — no timezone conversion of the activity rows is needed.
   *
   * Tenant scope is the CALLER'S clientId (for an assumed GIFSY operator that is the
   * assumed tenant — consistent with the other reports). Activity is scoped by
   * `userId IN <tenant user ids>`, NOT by activity.clientId, because activity may be
   * stamped under an assumed context; the user's home tenant is the source of truth.
   */
  async sessionReport(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    // 1. Tenant users.
    const users = await this.prisma.user.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: { id: true, name: true, phone: true, role: true, lastLoginAt: true },
      orderBy: { name: 'asc' },
    });
    const userIds = users.map((u) => u.id);

    // 2. 13-month IST window, OLDEST → NEWEST. IST is a fixed UTC+5:30 offset (no DST):
    //    shift "now" by +5:30 and read the year/month off the shifted UTC fields.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    const curYear = nowIst.getUTCFullYear();
    const curMonth = nowIst.getUTCMonth(); // 0-based

    const months: { ym: string; label: string }[] = [];
    for (let i = 12; i >= 0; i--) {
      // Start 12 months before the current month, walk forward to current inclusive.
      const d = new Date(Date.UTC(curYear, curMonth - i, 1));
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth(); // 0-based
      const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
      months.push({ ym, label: `${MONTHS[m]} ${y}` });
    }

    // 3. windowStart = UTC midnight of the first day of the OLDEST bucket month.
    const oldest = months[0].ym; // 'YYYY-MM'
    const windowStart = new Date(`${oldest}-01T00:00:00.000Z`);

    // 4. Bucket activity rows in JS: userId → { ym → activeDayCount }. Each row is a
    //    distinct day (composite-unique on [userId, activityDate]) so counting rows = days.
    const counts = new Map<string, Map<string, number>>();
    if (userIds.length > 0) {
      const activity = await this.prisma.userActivityDay.findMany({
        where: { userId: { in: userIds }, activityDate: { gte: windowStart } },
        select: { userId: true, activityDate: true },
      });
      for (const a of activity) {
        const ym = a.activityDate.toISOString().slice(0, 7); // 'YYYY-MM'
        let byMonth = counts.get(a.userId);
        if (!byMonth) {
          byMonth = new Map<string, number>();
          counts.set(a.userId, byMonth);
        }
        byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1);
      }
    }

    // 5. App installed (owner 2026-11-24, all tenants): ONE tenant-wide read of the pwa_install rows — the SAME
    //    population as the App Adoption page's "Installed to home screen" (tenantInstallWhere) — never per row.
    // 6. Level-ID columns (ISR ID · SO ID · … — the tenant's levels ranked 1..5): the installed-users Excel's resolver
    //    (reports/area/user-area.ts), 4 tenant-wide reads, cached per tenant (shared with the Usage report).
    const clientId = (user.clientId ?? '').trim();
    const platformsByUser = new Map<string, Set<string>>();
    let area: UserAreaResolver | null = null;
    if (clientId && users.length > 0) {
      const installs = await this.prisma.pwaInstall.findMany({
        where: tenantInstallWhere(clientId),
        select: { userId: true, platform: true },
      });
      for (const i of installs) {
        const set = platformsByUser.get(i.userId) ?? new Set<string>();
        set.add(i.platform);
        platformsByUser.set(i.userId, set);
      }
      // Fresh read (not the 60 s usage-page cache): the level IDs must match the App Adoption installed-users
      // Excel, which also reads fresh — right after a hierarchy upload the two files must never disagree.
      area = await loadUserAreaResolver(this.prisma as unknown as AreaPrisma, clientId);
    }
    const monthLabels = months.map((m) => m.label);
    const idHeaders = area
      ? installedUsersIdHeaders(area.idLevels, [
          ...SESSION_REPORT_LEAD_HEADERS,
          SESSION_REPORT_APP_HEADER,
          SESSION_REPORT_LAST_LOGIN_HEADER,
          ...monthLabels,
        ])
      : [];

    // 7. Rows — activeDays omits months with no activity.
    const rows = users.map((u) => {
      const byMonth = counts.get(u.id);
      const activeDays: Record<string, number> = {};
      if (byMonth) {
        for (const [ym, n] of byMonth) activeDays[ym] = n;
      }
      const appPlatforms = platformLabels(platformsByUser.get(u.id) ?? []);
      return {
        userId: u.id,
        name: u.name,
        phone: u.phone,
        role: u.role,
        appInstalled: appPlatforms.length > 0,
        appPlatforms,
        // One cell per idHeaders entry ('' = blank: admin, or a level below the user — see the About sheet).
        levelIds: area ? area.resolveIds({ id: u.id, role: u.role }) : [],
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        activeDays,
      };
    });

    // 8. XLSX — one row per user: S.No · Name · Mobile · Role · App Installed · <level> ID × ≤5 · Last Login · months.
    if (q.format === ReportFormat.XLSX) {
      const sheetRows = rows.map((r, i) => {
        const out: Record<string, unknown> = {
          'S.No': i + 1,
          Name: r.name,
          Mobile: r.phone,
          Role: r.role,
          [SESSION_REPORT_APP_HEADER]: appInstalledCell(r.appPlatforms),
        };
        idHeaders.forEach((h, c) => {
          out[h] = r.levelIds[c] ?? '';
        });
        out[SESSION_REPORT_LAST_LOGIN_HEADER] = this.formatIstDateTime(r.lastLoginAt);
        for (const mo of months) {
          out[mo.label] = r.activeDays[mo.ym] ?? 0;
        }
        return out;
      });
      // "About" — how to read the App Installed + level-ID columns (same level-ID wording as the installed-users Excel).
      const aboutRows: [string, string][] = [
        [SESSION_REPORT_APP_HEADER, SESSION_REPORT_APP_NOTE],
        ...(area ? levelIdAboutRows(area, idHeaders) : []),
        ['Month columns', SESSION_REPORT_ACTIVE_NOTE],
      ];
      return this.toXlsx(
        [
          { name: 'Session Report', rows: sheetRows },
          { name: 'About', rows: aboutRows.map(([k, v]) => ({ 'About this report': k, Notes: v })) },
        ],
        'session-report.xlsx',
      );
    }

    // 9. JSON.
    return this.toJson({
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Kolkata',
      months,
      idHeaders,
      rows,
    });
  }

  // ── Redemption report ─────────────────────────────────────────────────────────
  /**
   * GET /v1/reports/redemptions — the hub card's on-screen summary (totals + per-status counts + zone/state pickers)
   * for the same filters and tenant scope as the 'redemption-report' Excel kind. See reports/redemptions/.
   */
  async redemptionSummary(user: JwtPayload, q: RedemptionReportQueryDto): Promise<RedemptionScreenSummary> {
    return redemptionScreenSummary(this.prisma, user, q, new Date());
  }

  /** Matching order count for the redemption export (validates scope + an un-assumed owner's ?clientId=). */
  async redemptionCount(user: JwtPayload, q: RedemptionReportQueryDto): Promise<number> {
    return redemptionOrderCount(this.prisma, user, q, new Date());
  }

  // ── Usage Report ──────────────────────────────────────────────────────────────
  /**
   * Usage Report (JSON) — who used the app in an IST date range, how (installed app vs browser; phone vs
   * computer), and for how long (a minimum). One page of rows + totals over the whole filtered population.
   * Built by the shared buildUsageReport (also behind the 'usage-report' Excel kind). Tenant = the caller's
   * JWT clientId, exactly like the Session Report. See reports/usage/usage-report.ts.
   */
  async usageReport(user: JwtPayload, q: UsageReportQueryDto): Promise<ReportResult> {
    const params = resolveUsageParams(q);
    const report = await buildUsageReport(this.prisma, user.clientId, params);
    return this.toJson(pageOfUsageReport(report, params));
  }

  /**
   * Location-compliance report (LOCATION-GATE.md) — per sales rep: KYCs / visibility captures, no GPS, poor accuracy,
   * unverifiable, blocked outside the fence, medians. Built by the shared buildLocationReport (also behind the
   * 'location-compliance' Excel kind). Tenant = the caller's JWT clientId, exactly like the Usage report.
   */
  /**
   * Whether the Location report is available for the caller's tenant: every existing tenant since 2026-11-21 (default
   * ON; an emergency-off tenant keeps its history, with a "switched off" banner — `requireLocation` tells the tile).
   */
  async locationComplianceEnabled(user: JwtPayload): Promise<{ enabled: boolean; requireLocation: boolean }> {
    const clientId = (user.clientId ?? '').trim();
    if (!clientId) return { enabled: false, requireLocation: false };
    const c = await this.prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
    return { enabled: !!c, requireLocation: !!c && isLocationRequired(c.features) };
  }

  async locationCompliance(user: JwtPayload, q: LocationComplianceQueryDto): Promise<ReportResult> {
    const params = resolveLocationParams(q);
    const report = await buildLocationReport(this.prisma, user.clientId, params);
    return this.toJson(pageOfLocationReport(report, params));
  }

  /** Formats an ISO timestamp as IST 'YYYY-MM-DD HH:mm' (fixed UTC+5:30); '' if null. */
  private formatIstDateTime(iso: string | null): string {
    if (!iso) return '';
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  // ── KYC Status ────────────────────────────────────────────────────────────────
  /**
   * A FULL SNAPSHOT of every non-deleted tenant outlet and its current KYC status —
   * ONE row per outlet, including outlets that have NEVER started KYC (they show
   * "Not Started"). This is deliberately NOT a date-windowed activity export: there is
   * no date filter, so `dateFrom` / `dateTo` are ignored here (the shared DTO keeps them
   * for the other, activity-style reports).
   *
   * Status is the canonical dashboard-style KYC stage (deriveKycStage, shared with the
   * KYC dashboard) derived from the owner partner's LATEST submission, overlaid with the
   * outlet-level lifecycle states that sit OUTSIDE the KYC pipeline — Deactivated
   * (deactivatedAt set), Parked / Not Interested (kycIntent) — so every outlet's real
   * state is reflected and none is silently dropped.
   *
   * ONE tenant-scoped `outlet.findMany` with the owner partner's latest submission
   * included (mirrors the dashboard's `kycSubmissions orderBy createdAt desc take 1`) —
   * NO N+1, one query for the whole tenant (~2,989 outlets for Deoleo, like outletMaster).
   */
  async kycStatus(user: JwtPayload, _q: ReportRangeQueryDto): Promise<ReportResult> {
    // JSON format only — `format=xlsx` is the `kyc-status` export kind (exports/kinds/batch1/kyc-status.ts), routed
    // by the controller; both use kycStatusRows. No date filter: a full outlet snapshot (dateFrom/dateTo ignored).
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: KYC_STATUS_OUTLET_SELECT,
      orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
    });
    // "Routing" column only for a gifsyRejectFastTrack tenant (Bajaj); every other tenant's rows are unchanged.
    const routing = await kycStatusRoutingEnabled(this.prisma, user.clientId);
    const data = await kycStatusRows(this.prisma, user.clientId, outlets, 0, { routing });
    return this.toJson({ data, recordCount: data.length });
  }
}
