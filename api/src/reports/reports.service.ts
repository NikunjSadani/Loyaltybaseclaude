import { ForbiddenException, Injectable } from '@nestjs/common';
import { OutletKycIntent, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportFormat, ReportRangeQueryDto, TdsReportQueryDto } from './dto/reports.dto';
import { buildXlsx, ReportSheet } from '../common/xlsx';
import { platformWide } from '../common/tenant-scope';
import { istDayRangeFilter } from '../common/ist-date';
import { deriveKycStage } from '../common/kyc-rekyc.helper';

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
   * Master Visibility gate (mirrors the visibility services). The visibility-status
   * report exposes a tenant's VisibilitySubmission rows; when the tenant's master switch
   * is OFF this must 403 for the tenant's own users (incl. MIS_USER) so residual data from
   * a previously-enabled period is not leaked. The GIFSY operator is exempt only in true
   * platform context (`!assumed`).
   */
  private async assertVisibilityEnabled(user: JwtPayload): Promise<void> {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (platformWide(user)) return;
    if (!(await this.tenant.resolveVisibilityEnabled(user.clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

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
  async visibilityStatus(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    await this.assertVisibilityEnabled(user);

    // Visibility (POSM) captures are keyed by (outlet, window); clientId is a direct column.
    const where: Prisma.VisibilityCaptureWhereInput = { clientId: user.clientId };
    const createdAt = istDayRangeFilter(q.dateFrom, q.dateTo);
    if (createdAt) where.createdAt = createdAt;

    const submissions = await this.prisma.visibilityCapture.findMany({
      where,
      include: {
        outlet: { select: { name: true, city: true } },
        submittedBy: { select: { employeeCode: true, user: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = submissions.map((s, i) => ({
      'S.No': i + 1,
      'Capture ID': s.id,
      'Outlet Code': s.outletCode,
      'Outlet Name': s.outlet?.name ?? s.outletName,
      City: s.outlet?.city ?? '',
      Window: s.windowKey,
      Status: s.status,
      'Captured By': s.submittedBy?.user?.name ?? '',
      Latitude: s.captureLat?.toString() ?? '',
      Longitude: s.captureLng?.toString() ?? '',
      'Geo-fence': s.geoFenceOk === null ? 'unverifiable' : s.geoFenceOk ? 'ok' : 'outside',
      'Submitted On': s.createdAt.toISOString().split('T')[0],
    }));

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx([{ name: 'Visibility Status', rows: data }], 'visibility-status.xlsx');
    }
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
      Date: r.createdAt.toISOString().split('T')[0],
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
      'Created On': t.createdAt.toISOString().split('T')[0],
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

    // 5. Rows — activeDays omits months with no activity.
    const rows = users.map((u) => {
      const byMonth = counts.get(u.id);
      const activeDays: Record<string, number> = {};
      if (byMonth) {
        for (const [ym, n] of byMonth) activeDays[ym] = n;
      }
      return {
        userId: u.id,
        name: u.name,
        phone: u.phone,
        role: u.role,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        activeDays,
      };
    });

    // 7. XLSX — one row per user; fixed lead columns then one column per month.
    if (q.format === ReportFormat.XLSX) {
      const sheetRows = rows.map((r, i) => {
        const out: Record<string, unknown> = {
          'S.No': i + 1,
          Name: r.name,
          Mobile: r.phone,
          Role: r.role,
          'Last Login': this.formatIstDateTime(r.lastLoginAt),
        };
        for (const mo of months) {
          out[mo.label] = r.activeDays[mo.ym] ?? 0;
        }
        return out;
      });
      return this.toXlsx([{ name: 'Session Report', rows: sheetRows }], 'session-report.xlsx');
    }

    // 6. JSON.
    return this.toJson({
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Kolkata',
      months,
      rows,
    });
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
  async kycStatus(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    // NOTE: no date filter — this is a full outlet snapshot. `q.dateFrom/dateTo` are ignored
    // (only `q.format` is read, below), so passing a date range does not change the row set.
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: {
        zone: true,
        outletCode: true,
        name: true,
        programName: true,
        deactivatedAt: true,
        kycIntent: true,
        partner: {
          select: {
            ownerName: true,
            phone: true,
            businessName: true,
            panNumber: true,
            // Latest submission for the owner partner (mirrors the KYC dashboard include).
            kycSubmissions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, submittedAt: true, createdAt: true },
            },
          },
        },
      },
      orderBy: { outletCode: 'asc' },
    });

    // Per-outlet status: outlet-level lifecycle overlay first (states outside the KYC
    // pipeline), then the canonical dashboard KYC stage from the latest submission.
    const statusFor = (o: (typeof outlets)[number]): string => {
      if (o.deactivatedAt) return 'Deactivated';
      if (o.kycIntent === OutletKycIntent.PARKED) return 'Parked';
      if (o.kycIntent === OutletKycIntent.NOT_INTERESTED) return 'Not Interested';
      return deriveKycStage(o.partner?.kycSubmissions[0]?.status ?? null);
    };

    const data = outlets.map((o, i) => {
      const sub = o.partner?.kycSubmissions[0];
      // Latest submission date; blank when the outlet has never started KYC. submittedAt
      // is the real submit instant, falling back to the row's createdAt for a DRAFT.
      const lastSubmittedOn = sub
        ? (sub.submittedAt ?? sub.createdAt).toISOString().split('T')[0]
        : '';
      return {
        'S.No': i + 1,
        'Outlet ID': o.outletCode ?? '',
        'Outlet Name': o.name ?? '',
        Zone: o.zone ?? '',
        'Program Name': o.programName ?? '',
        'Business Name': o.partner?.businessName ?? '',
        'Owner/User Name': o.partner?.ownerName ?? '',
        Mobile: o.partner?.phone ?? '',
        PAN: o.partner?.panNumber ?? '',
        Status: statusFor(o),
        'Last Submitted On': lastSubmittedOn,
      };
    });

    if (q.format === ReportFormat.XLSX) {
      // Zero outlets → seed one all-blank row so the sheet still shows the column headers
      // (an empty json_to_sheet yields a header-less blank sheet — the "barely any
      // columns" confusion; mirrors the outlet-master / target-vs-sales reports).
      const rows =
        data.length > 0
          ? data
          : [
              {
                'S.No': '', 'Outlet ID': '', 'Outlet Name': '', Zone: '', 'Program Name': '',
                'Business Name': '', 'Owner/User Name': '', Mobile: '', PAN: '',
                Status: '', 'Last Submitted On': '',
              },
            ];
      return this.toXlsx([{ name: 'KYC Status', rows }], 'kyc-status.xlsx');
    }
    return this.toJson({ data, recordCount: data.length });
  }
}
