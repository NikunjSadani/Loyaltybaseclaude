import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Msg91Service } from '../../notifications/msg91.service';
import { istStartOfDay } from '../../common/business-hours';
import { loadHolidaySet } from '../../common/holiday-calendar';
import { loadReportRecipients } from '../../common/report-recipients';
import { formatDateIST } from '../../common/ist-date';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  KYC_SLA_MIN_HOURS,
  KYC_SLA_MAX_HOURS,
  KycSlaTargets,
} from '../../common/kyc-sla-stage';
import { buildCreditsPayoutsReport } from './credits-payouts-report';
import { buildKycActionablesReport } from './kyc-actionables-report';
import { ReportContext, ReportKey, ReportResult } from './report.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-report outcome of one run (returned from the endpoint for observability). */
interface ReportOutcome {
  key: ReportKey;
  status: 'sent' | 'suppressed-empty' | 'no-recipients' | 'error';
  recipients?: number;
  empty?: boolean;
  error?: string;
}

/**
 * Runs the daily INTERNAL Gifsy email reports. Driven by Cloud Scheduler → the secret-gated
 * POST /v1/reports/run endpoint (Mon–Sat). Does ALL the Prisma + context assembly, then hands
 * each builder a plain ReportContext and sends the rendered HTML via MSG91 to the Gifsy-configured
 * recipient list. Every report is isolated in its own try/catch so one failure never blocks the other.
 *
 * Suppression policy (owner-locked): Credits/Payouts is suppress-if-empty (no email on a quiet day);
 * KYC actionables always sends (a daily digest, "all clear" when nothing is pending).
 */
@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  async runDailyReports(nowMs: number = Date.now()): Promise<{ dateLabel: string; reports: ReportOutcome[] }> {
    const startIst = istStartOfDay(nowMs);
    const ctx: ReportContext = {
      startIst,
      endIst: startIst + DAY_MS,
      dateLabel: formatDateIST(new Date(nowMs)),
      nowMs,
      tenantNames: await this.loadTenantNames(),
      activeTenantIds: [],
    };
    ctx.activeTenantIds = [...ctx.tenantNames.keys()];

    // Shared inputs loaded once for the whole run.
    const holidays = await loadHolidaySet(this.prisma);
    const slaTargets = await this.loadSlaTargets();
    const recipients = await loadReportRecipients(this.prisma);

    const reports: ReportOutcome[] = [];
    reports.push(
      await this.runOne('creditsPayouts', recipients.creditsPayouts, true, () =>
        buildCreditsPayoutsReport(this.prisma, ctx),
      ),
    );
    reports.push(
      await this.runOne('kycActionables', recipients.kycActionables, false, () =>
        buildKycActionablesReport(this.prisma, ctx, holidays, slaTargets),
      ),
    );

    this.logger.log(`Daily reports (${ctx.dateLabel}): ${reports.map((r) => `${r.key}=${r.status}`).join(', ')}`);
    return { dateLabel: ctx.dateLabel, reports };
  }

  /** Build + send a single report, isolating any failure to that report. */
  private async runOne(
    key: ReportKey,
    to: string[],
    suppressIfEmpty: boolean,
    build: () => Promise<ReportResult>,
  ): Promise<ReportOutcome> {
    try {
      const result = await build();
      if (to.length === 0) return { key, status: 'no-recipients', empty: result.empty };
      if (suppressIfEmpty && result.empty) return { key, status: 'suppressed-empty', empty: true };
      await this.msg91.sendEmail({ to, subject: result.subject, html: result.html });
      return { key, status: 'sent', recipients: to.length, empty: result.empty };
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      this.logger.error(`Report "${key}" failed: ${error}`);
      return { key, status: 'error', error };
    }
  }

  /** clientId → display name (branding.displayName ?? internalName) for all ACTIVE tenants. */
  private async loadTenantNames(): Promise<Map<string, string>> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, internalName: true, branding: true },
    });
    const map = new Map<string, string>();
    for (const c of clients) {
      const branding = (c.branding ?? {}) as Record<string, unknown>;
      const display = typeof branding.displayName === 'string' && branding.displayName.trim() ? branding.displayName : c.internalName;
      map.set(c.id, display);
    }
    return map;
  }

  /** clientId → the two-stage KYC SLA targets { fieldHrs, gifsyHrs } (validated 1–168); tenants
   *  without a row default to 24/96 in the builder. */
  private async loadSlaTargets(): Promise<Map<string, KycSlaTargets>> {
    const rows = await this.prisma.programSetting.findMany({
      where: { settingKey: { in: [KYC_FIELD_SLA_KEY, KYC_GIFSY_SLA_KEY] } },
      select: { clientId: true, settingKey: true, settingValue: true },
    });
    const bound = (raw: unknown, def: number): number => {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      return Number.isInteger(n) && n >= KYC_SLA_MIN_HOURS && n <= KYC_SLA_MAX_HOURS ? n : def;
    };
    const map = new Map<string, KycSlaTargets>();
    for (const r of rows) {
      const cur = map.get(r.clientId) ?? { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };
      if (r.settingKey === KYC_FIELD_SLA_KEY) cur.fieldHrs = bound(r.settingValue, KYC_FIELD_SLA_DEFAULT);
      else if (r.settingKey === KYC_GIFSY_SLA_KEY) cur.gifsyHrs = bound(r.settingValue, KYC_GIFSY_SLA_DEFAULT);
      map.set(r.clientId, cur);
    }
    return map;
  }
}
