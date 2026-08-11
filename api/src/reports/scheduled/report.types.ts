/**
 * Shared contract for the scheduled INTERNAL Gifsy email reports (daily Mon–Sat).
 *
 * Design (owner-locked 2026-08): two separate all-tenant reports emailed to a Gifsy-configured
 * recipient list — #1 Credits/Payouts summary (suppress-if-empty) and #3 KYC actionables digest
 * (always sent). The RUNNER (scheduled-reports.service.ts) does all the Prisma + assembles the
 * per-report ReportContext, then calls each pure-ish builder, which returns a rendered
 * ReportResult. This seam keeps each builder in its own file (no cross-file contention) and its
 * HTML deterministic + unit-testable.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { KycSlaTargets } from '../../common/kyc-sla-stage';

/** Stable report keys — also the keys under which recipient lists are stored (reportRecipients). */
export type ReportKey = 'creditsPayouts' | 'kycActionables';

/** Per-run context the runner assembles once and hands to every builder. */
export interface ReportContext {
  /** UTC-ms of IST-midnight today — inclusive lower bound of the "today IST" window. */
  startIst: number;
  /** UTC-ms of the next IST-midnight — exclusive upper bound. */
  endIst: number;
  /** Human date the report covers, e.g. "11 Aug 2026" (IST). */
  dateLabel: string;
  /** "now" for SLA age math — passed in (not Date.now()) so builders are pure + deterministic in tests. */
  nowMs: number;
  /** clientId → human tenant/brand name (branding.displayName ?? internalName). */
  tenantNames: Map<string, string>;
  /** clientIds of all ACTIVE tenants (Client.status === 'ACTIVE'). */
  activeTenantIds: string[];
}

/** A rendered report ready to send. `empty` lets the runner suppress send for suppress-if-empty reports. */
export interface ReportResult {
  key: ReportKey;
  /** Email subject line (already includes the date). */
  subject: string;
  /** Full email HTML body. */
  html: string;
  /** true when there was nothing material to report (no activity / nothing pending). */
  empty: boolean;
}

/**
 * Builder signatures the runner calls. Builders MUST be defensive (never throw into the runner —
 * a failure in one report must not block the other) and MUST HTML-escape every dynamic value
 * (see email-html.ts `esc`).
 *
 *  - Credits/Payouts (#1): day-scoped to [ctx.startIst, ctx.endIst) via CreditBatch.confirmedAt +
 *    PayoutTransaction.completedAt (SUCCESS). empty = no batches AND no payouts today.
 *  - KYC actionables (#3): all-tenant pending-KYC roll-up by stage, business-hours SLA
 *    (businessHoursBetween + the holiday set), per-tenant slaTargetHours. empty = zero pending.
 */
export type CreditsPayoutsBuilder = (prisma: PrismaService, ctx: ReportContext) => Promise<ReportResult>;

export type KycActionablesBuilder = (
  prisma: PrismaService,
  ctx: ReportContext,
  holidays: Set<string>,
  /** clientId → { fieldHrs, gifsyHrs } — the two-stage SLA targets; missing tenants default to 24/96. */
  slaTargets: Map<string, KycSlaTargets>,
) => Promise<ReportResult>;
