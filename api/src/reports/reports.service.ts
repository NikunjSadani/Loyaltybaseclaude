import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportFormat, ReportRangeQueryDto, TdsReportQueryDto } from './dto/reports.dto';
import { buildXlsx, ReportSheet } from '../common/xlsx';

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
    if (user.role === 'GIFSY_ADMIN' && !user.assumed) return;
    if (!(await this.tenant.resolveVisibilityEnabled(user.clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /** Parses an optional ISO date string to a Date, mirroring `new Date(...)`. */
  private parseDate(v?: string): Date | undefined {
    return v ? new Date(v) : undefined;
  }

  /** Builds a createdAt range filter from optional bounds. */
  private createdAtRange(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = from;
    if (to) range.lte = to;
    return range;
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
    const dateFrom = this.parseDate(q.dateFrom);
    const dateTo = this.parseDate(q.dateTo);

    const where: Prisma.VisibilitySubmissionWhereInput = {
      partner: { clientId: user.clientId },
    };
    const createdAt = this.createdAtRange(dateFrom, dateTo);
    if (createdAt) where.createdAt = createdAt;

    const submissions = await this.prisma.visibilitySubmission.findMany({
      where,
      include: {
        partner: { select: { businessName: true } },
        outlet: { select: { name: true, city: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = submissions.map((s, i) => ({
      'S.No': i + 1,
      'Submission ID': s.id,
      'Partner Name': s.partner?.businessName ?? '',
      'Outlet Name': s.outlet?.name ?? '',
      City: s.outlet?.city ?? '',
      'Program ID': s.programId,
      Status: s.status,
      Latitude: s.latitude?.toString() ?? '',
      Longitude: s.longitude?.toString() ?? '',
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
    const dateFrom = this.parseDate(q.dateFrom);
    const dateTo = this.parseDate(q.dateTo);
    const financialYear = q.fy ?? undefined;

    const where: Prisma.TdsRecordWhereInput = {
      payoutTransaction: { batch: { clientId: user.clientId } },
    };
    if (financialYear) where.assessmentYear = financialYear;
    const createdAt = this.createdAtRange(dateFrom, dateTo);
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
    const dateFrom = this.parseDate(q.dateFrom);
    const dateTo = this.parseDate(q.dateTo);

    const where: Prisma.PayoutTransactionWhereInput = {
      status: 'PENDING',
      batch: { clientId: user.clientId },
    };
    const createdAt = this.createdAtRange(dateFrom, dateTo);
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

  // ── Engagement ────────────────────────────────────────────────────────────────
  async engagement(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    const dateFrom =
      this.parseDate(q.dateFrom) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dateTo = this.parseDate(q.dateTo) ?? new Date();

    // Login activity
    const loginLogs = await this.prisma.loginLog.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo }, user: { clientId: user.clientId } },
      include: {
        user: { select: { id: true, name: true, phone: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Active users (logged in at least once)
    const activeUsers = new Set(loginLogs.map((l) => l.userId));

    // Total registered users
    const totalUsers = await this.prisma.user.count({
      where: { status: 'ACTIVE', clientId: user.clientId },
    });

    // Daily active users
    const dailyActivity: Record<string, Set<string>> = {};
    for (const log of loginLogs) {
      const day = log.createdAt.toISOString().split('T')[0];
      if (!dailyActivity[day]) dailyActivity[day] = new Set();
      dailyActivity[day].add(log.userId);
    }

    const dailyStats = Object.entries(dailyActivity)
      .map(([date, users]) => ({ date, activeUsers: users.size }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const data = loginLogs.map((l, i) => ({
      'S.No': i + 1,
      'User Name': l.user?.name ?? '',
      Mobile: l.user?.phone ?? '',
      Role: l.user?.role ?? '',
      'Login Time': l.createdAt.toISOString(),
      'IP Address': l.ipAddress ?? '',
      Device: l.deviceInfo ?? '',
    }));

    const summary = {
      totalActiveUsers: activeUsers.size,
      totalRegisteredUsers: totalUsers,
      engagementRate: totalUsers > 0 ? Math.round((activeUsers.size / totalUsers) * 100) : 0,
      totalLogins: loginLogs.length,
      dailyStats,
      dateFrom: dateFrom.toISOString().split('T')[0],
      dateTo: dateTo.toISOString().split('T')[0],
    };

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx(
        [
          { name: 'Login Activity', rows: data },
          { name: 'Daily Stats', rows: dailyStats },
        ],
        'engagement.xlsx',
      );
    }
    return this.toJson({ data, summary, recordCount: data.length });
  }

  // ── KYC Status ────────────────────────────────────────────────────────────────
  async kycStatus(user: JwtPayload, q: ReportRangeQueryDto): Promise<ReportResult> {
    const dateFrom = this.parseDate(q.dateFrom);
    const dateTo = this.parseDate(q.dateTo);

    const where: Prisma.KycSubmissionWhereInput = {
      user: { clientId: user.clientId },
    };
    const createdAt = this.createdAtRange(dateFrom, dateTo);
    if (createdAt) where.createdAt = createdAt;

    const submissions = await this.prisma.kycSubmission.findMany({
      where,
      include: {
        user: { select: { name: true, phone: true } },
        partner: { select: { businessName: true, panNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = submissions.map((s, i) => ({
      'S.No': i + 1,
      'Submission ID': s.id,
      'User Name': s.user?.name ?? '',
      Mobile: s.user?.phone ?? '',
      'Business Name': s.partner?.businessName ?? '',
      Status: s.status,
      'Submitted On': s.createdAt.toISOString().split('T')[0],
      PAN: s.partner?.panNumber ?? '',
    }));

    if (q.format === ReportFormat.XLSX) {
      return this.toXlsx([{ name: 'KYC Status', rows: data }], 'kyc-status.xlsx');
    }
    return this.toJson({ data, recordCount: data.length });
  }
}
