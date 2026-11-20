import { BadRequestException, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma, TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { istMonthBounds } from '../common/ist-date';
import { loadOutletTypeDisplayNames, labelFor } from '../common/outlet-type-display';
import { TargetsService } from '../targets/targets.service';
import { PointsLedgerQueryDto, TargetVsSalesQueryDto, TicketAgingQueryDto, ReportFormat } from './dto/reports.dto';
import { TARGET_VS_SALES_INSTANT_MAX_MONTHS } from '../exports/kinds/batch2/target-vs-sales.kind';
import {
  aggregateLedgerToRow,
  buildTargetVsSalesRows,
  buildTicketAgingRow,
  monthsInRange,
  PaceMonthResult,
  PointsLedgerReportRow,
  pointsLedgerXlsxRows,
  ReportMonth,
  summarizeAging,
  targetVsSalesMonthList,
  TicketAgingRow,
  ticketAgingXlsxRows,
} from './reports/report-helpers';
import {
  OUTLET_REFERENCE_TYPE,
  TICKET_CREATOR_SELECT,
  describeRaisedBy,
  resolveTicketOutlet,
} from '../tickets/ticket-submitter';

const ALLOWED_STATUSES = new Set<string>([
  'OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED', 'WAITING_ON_CLIENT',
]);
// WAITING_ON_CLIENT (asked the client admin for remarks) is an open ticket → aged by default.
const DEFAULT_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED', 'WAITING_ON_CLIENT'];

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Reports admin — ported from
 * platform/src/app/api/admin/reports/{outlet-master,points-ledger,ticket-aging}/route.ts.
 * (Outlet Master now lives in the `outlet-master` export kind — exports/kinds/batch1/outlet-master.ts.)
 *
 * DEMO_MODE branches and `@/lib/*-export` demo data are NOT ported
 * (RULE 3: real Prisma tables only). Pure aggregation/aging logic was ported
 * locally into reports/report-helpers.ts. xlsx downloads stream via
 * StreamableFile (passed through unwrapped by the global interceptor).
 *
 * Access: GIFSY_ADMIN | CLIENT_ADMIN (reports:export) for all three.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: TargetsService,
  ) {}

  private isValidYYYYMM(s: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  }

  // ── Points Ledger ────────────────────────────────────────────────────────────
  /** GET /v1/admin/reports/points-ledger — json (default) or xlsx. */
  async pointsLedger(user: JwtPayload, q: PointsLedgerQueryDto) {
    const from = q.from ?? '';
    const to = q.to ?? '';
    const format = q.format ?? 'json';

    if (!from || !to) {
      throw new BadRequestException('Query params `from` and `to` (YYYY-MM) are required.');
    }
    if (!this.isValidYYYYMM(from) || !this.isValidYYYYMM(to)) {
      throw new BadRequestException('`from` and `to` must be in YYYY-MM format.');
    }
    if (from > to) {
      throw new BadRequestException('`from` must not be after `to`.');
    }

    let months: ReportMonth[];
    try {
      months = monthsInRange(from, to);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid period range.';
      throw new BadRequestException(msg);
    }

    // Period window as IST month boundaries (UTC instants bounding the IST months).
    const periodStart = istMonthBounds(from).start;
    const periodEnd = istMonthBounds(to).endExclusive;

    // Outlet → partner (1:1) → wallets[0] → pointsLedger up to periodEnd.
    const outlets = await this.prisma.outlet.findMany({
      where: { partner: { clientId: user.clientId }, deletedAt: null },
      select: {
        id: true,
        name: true,
        outletType: { select: { id: true, name: true } },
        partner: {
          select: {
            wallets: {
              take: 1,
              select: {
                pointsLedger: {
                  where: { createdAt: { lt: periodEnd } },
                  select: { transactionType: true, points: true, createdAt: true },
                },
              },
            },
          },
        },
      },
    });

    // Per-tenant outlet-type display labels (displayName ?? name). Empty for Deoleo ⇒ byte-identical.
    const typeDisplayById = await loadOutletTypeDisplayNames(this.prisma, user.clientId);

    const rows: PointsLedgerReportRow[] = outlets
      .filter((o) => (o.partner?.wallets?.length ?? 0) > 0)
      .map((o) => {
        const wallet = o.partner!.wallets[0];
        const ledger = wallet.pointsLedger;

        const beforePeriod = ledger.filter((e) => e.createdAt < periodStart);
        const inPeriod = ledger.filter((e) => e.createdAt >= periodStart);

        // Opening balance = the redeemable-points balance as of period start. Ledger
        // `points` is SIGNED (credits +, debits −), so the balance is simply their sum
        // over every balance-affecting row — including REVERSE/ADJUST, which the prior
        // code dropped. LOCK/UNLOCK touch the locked bucket, not this balance, so skip them.
        // Σ signed points equals wallet.redeemablePoints for every real outlet (verified on
        // staging); the authoritative balance is the wallet scalar — a reconstruction can only
        // diverge on a seeded-scalar demo wallet or a legacy clawback-shortfall row (where the
        // ledger intentionally records more than was decremented), both negligible here.
        const openingBalance = beforePeriod.reduce((sum, e) => {
          if (e.transactionType === 'LOCK' || e.transactionType === 'UNLOCK') return sum;
          return sum + e.points;
        }, 0);

        return aggregateLedgerToRow(
          {
            outletId: o.id,
            outletName: o.name,
            outletType: o.outletType ? labelFor(typeDisplayById, o.outletType.id, o.outletType.name) : undefined,
          },
          openingBalance,
          inPeriod.map((e) => ({
            type: e.transactionType,
            points: e.points,
            createdAt: e.createdAt,
          })),
          months,
        );
      });

    if (format === 'xlsx') {
      const buffer = buildXlsx([{ name: 'Points Ledger', rows: pointsLedgerXlsxRows(rows, months) }]);
      const today = new Date().toISOString().split('T')[0];
      return new StreamableFile(buffer, {
        type: XLSX_TYPE,
        disposition: `attachment; filename="points-ledger-${today}.xlsx"`,
      });
    }

    return { months, rows };
  }

  // ── Ticket Aging ───────────────────────────────────────────────────────────
  /** GET /v1/admin/reports/ticket-aging — json (default) or xlsx. */
  async ticketAging(user: JwtPayload, q: TicketAgingQueryDto) {
    const format = q.format ?? 'json';

    // Parse statuses: param absent → default open set; present-but-empty → 400.
    let statuses: string[];
    if (q.status === undefined) {
      statuses = DEFAULT_STATUSES;
    } else {
      statuses = q.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 0) {
        throw new BadRequestException(
          'Provide at least one status, or omit the status filter.',
        );
      }
    }

    for (const s of statuses) {
      if (!ALLOWED_STATUSES.has(s)) {
        throw new BadRequestException(
          `Invalid status value: "${s}". Allowed: ${[...ALLOWED_STATUSES].join(', ')}.`,
        );
      }
    }

    const asOf = new Date();

    const where: Prisma.TicketWhereInput = {
      clientId: user.clientId,
      deletedAt: null,
      status: { in: statuses as TicketStatus[] },
      ...(q.category ? { category: q.category as TicketCategory } : {}),
      ...(q.priority ? { priority: q.priority as TicketPriority } : {}),
    };

    const tickets = await this.prisma.ticket.findMany({
      where,
      select: {
        ticketNumber: true,
        subject: true,
        category: true,
        priority: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        firstResponseAt: true,
        slaBreached: true,
        referenceType: true,
        referenceId: true,
        // Who raised it (outlet owner vs sales person + designation) + the outlet — same rules
        // as the tickets console (tickets/ticket-submitter.ts).
        createdBy: { select: TICKET_CREATOR_SELECT },
        assignedTo: { select: { name: true } },
      },
    });

    const refIds = [
      ...new Set(
        tickets
          .filter((t) => t.referenceType === OUTLET_REFERENCE_TYPE && t.referenceId)
          .map((t) => t.referenceId as string),
      ),
    ];
    const refOutlets = refIds.length
      ? await this.prisma.outlet.findMany({
          where: { id: { in: refIds }, clientId: user.clientId },
          select: { id: true, outletCode: true, name: true },
        })
      : [];
    const outletById = new Map((refOutlets ?? []).map((o) => [o.id, o]));

    const rows: TicketAgingRow[] = tickets.map((t) =>
      buildTicketAgingRow(
        {
          ticketNumber: t.ticketNumber,
          subject: t.subject,
          category: String(t.category),
          priority: String(t.priority),
          status: String(t.status),
          createdByName: t.createdBy?.name ?? 'Unknown',
          raisedBy: describeRaisedBy(t.createdBy).label,
          outletCode: resolveTicketOutlet(t, t.createdBy, outletById)?.outletCode ?? '',
          assignedToName: t.assignedTo?.name ?? undefined,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          firstResponseAt: t.firstResponseAt ?? null,
          slaBreached: t.slaBreached,
        },
        asOf,
      ),
    );

    if (format === 'xlsx') {
      const buffer = buildXlsx([{ name: 'Ticket Aging', rows: ticketAgingXlsxRows(rows) }]);
      const today = asOf.toISOString().split('T')[0];
      return new StreamableFile(buffer, {
        type: XLSX_TYPE,
        disposition: `attachment; filename="ticket-aging-${today}.xlsx"`,
      });
    }

    const summary = summarizeAging(rows);
    return { rows, summary, asOf: asOf.toISOString() };
  }

  // ── Target vs Sales Performance ───────────────────────────────────────────────
  /**
   * GET /v1/admin/reports/target-vs-sales — the json on-screen preview (≤ 3 months; the xlsx download of up to 15
   * months is the 'target-vs-sales' export kind, routed by the controller). One row per (outlet × month) across an
   * inclusive fromMonth→toMonth range. For each enabled KpiDef the sheet carries
   * three columns: Target, Achieved, Pace %.
   *
   * The target↔actual join is NOT re-implemented: it delegates to
   * TargetsService.getPace per month (the exact OutletTarget.targetValues ↔
   * OutletSalesRecord.kpiValues join on (clientId, outletCode, month) with the
   * pace = achieved÷target divide-by-zero guard). getPace is tenant-scoped by
   * `user.clientId` from the JWT — this endpoint takes NO clientId param, so a
   * caller cannot read another tenant's data (an un-assumed GIFSY_ADMIN sees only
   * its own — empty — client, an assumed one sees the assumed tenant, exactly like
   * every sibling report). Batches one getPace (2 queries) per month + one KpiDef
   * query — never N+1 per outlet.
   *
   * Blank-not-zero: getPace returns null for an ABSENT target/actual key; those
   * become '' (blank) here, while a stored 0 stays 0 — mirroring the upload rule
   * "blank cells are skipped, not stored as 0". Pace % is blank when pace is null.
   */
  async targetVsSales(user: JwtPayload, q: TargetVsSalesQueryDto) {
    const fromMonth = q.fromMonth ?? '';
    const toMonth = q.toMonth ?? '';
    const format = q.format ?? ReportFormat.JSON;

    if (!fromMonth || !toMonth) {
      throw new BadRequestException('Query params `fromMonth` and `toMonth` (YYYY-MM) are required.');
    }
    if (!this.isValidYYYYMM(fromMonth) || !this.isValidYYYYMM(toMonth)) {
      throw new BadRequestException('`fromMonth` and `toMonth` must be in YYYY-MM format.');
    }

    let months: string[];
    try {
      months = targetVsSalesMonthList(fromMonth, toMonth);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid period range.';
      throw new BadRequestException(msg);
    }

    // The xlsx download is the 'target-vs-sales' export kind (Downloads page — streamed, or prepared in the background
    // for > 3 months); the controller routes format=xlsx there. This method is the on-screen JSON preview only, held
    // in memory, so it is capped at the same 3 months.
    if (format === ReportFormat.XLSX) {
      throw new BadRequestException('Use the report download for the Excel file.');
    }
    if (months.length > TARGET_VS_SALES_INSTANT_MAX_MONTHS) {
      throw new BadRequestException(
        `The on-screen preview covers up to ${TARGET_VS_SALES_INSTANT_MAX_MONTHS} months (you chose ${months.length}). ` +
          'Use Download Excel for a longer range — it will be prepared on the Downloads page.',
      );
    }

    // KPI columns = the tenant's ENABLED KpiDef catalogue, in KpiDef order.
    const kpiDefs = await this.prisma.kpiDef.findMany({
      where: { clientId: user.clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
      select: { code: true, label: true, unit: true },
    });

    // Reuse getPace's join per month (tenant-scoped by user.clientId).
    const paceResults: PaceMonthResult[] = [];
    for (const month of months) {
      const res = await this.targets.getPace(user, { month });
      paceResults.push({ month, outlets: res.outlets });
    }

    const { rows, kpis } = buildTargetVsSalesRows(months, kpiDefs, paceResults);
    return { fromMonth, toMonth, months, kpis, rows };
  }
}
