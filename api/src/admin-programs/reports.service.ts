import { BadRequestException, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma, TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { PointsLedgerQueryDto, TicketAgingQueryDto } from './dto/reports.dto';
import {
  aggregateLedgerToRow,
  buildTicketAgingRow,
  monthsInRange,
  PointsLedgerReportRow,
  pointsLedgerXlsxRows,
  ReportMonth,
  summarizeAging,
  TicketAgingRow,
  ticketAgingXlsxRows,
} from './reports/report-helpers';

const ALLOWED_STATUSES = new Set<string>([
  'OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED',
]);
const DEFAULT_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED'];

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Reports admin — ported from
 * platform/src/app/api/admin/reports/{outlet-master,points-ledger,ticket-aging}/route.ts.
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
  constructor(private readonly prisma: PrismaService) {}

  private isValidYYYYMM(s: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  }

  // ── Outlet Master ──────────────────────────────────────────────────────────
  /**
   * GET /v1/admin/reports/outlet-master — xlsx download.
   * NOTE: the source route had no implemented production query (it returned
   * demo data behind a TODO). This faithful port implements the real
   * tenant-scoped Outlet query the source's TODO described.
   */
  async outletMaster(user: JwtPayload): Promise<StreamableFile> {
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, deletedAt: null },
      select: {
        outletCode: true,
        name: true,
        ownerName: true,
        phone: true,
        city: true,
        district: true,
        state: true,
        pincode: true,
        distributorCode: true,
        distributorName: true,
        beat: true,
        metro: true,
        zone: true,
        programName: true,
        programCategory: true,
        isActive: true,
        outletType: { select: { name: true } },
      },
      orderBy: { outletCode: 'asc' },
    });

    const rows: Record<string, unknown>[] = outlets.map((o) => ({
      'Outlet Code': o.outletCode,
      'Outlet Name': o.name,
      'Outlet Type': o.outletType?.name ?? '',
      'Owner Name': o.ownerName ?? '',
      Phone: o.phone ?? '',
      City: o.city,
      District: o.district ?? '',
      State: o.state,
      Pincode: o.pincode ?? '',
      'Distributor Code': o.distributorCode ?? '',
      'Distributor Name': o.distributorName ?? '',
      Beat: o.beat ?? '',
      Metro: o.metro ?? '',
      Zone: o.zone ?? '',
      'Program Name': o.programName ?? '',
      'Program Category': o.programCategory ?? '',
      Active: o.isActive ? 'Yes' : 'No',
    }));

    const buffer = buildXlsx([{ name: 'Outlet Master', rows }]);
    const today = new Date().toISOString().split('T')[0];
    return new StreamableFile(buffer, {
      type: XLSX_TYPE,
      disposition: `attachment; filename="outlet-master-${today}.xlsx"`,
    });
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

    // Period window as UTC Date boundaries.
    const [fromYear, fromMonthNum] = from.split('-').map(Number);
    const [toYear, toMonthNum] = to.split('-').map(Number);
    const periodStart = new Date(Date.UTC(fromYear, fromMonthNum - 1, 1));
    const periodEnd =
      toMonthNum === 12
        ? new Date(Date.UTC(toYear + 1, 0, 1))
        : new Date(Date.UTC(toYear, toMonthNum, 1));

    // Outlet → partner (1:1) → wallets[0] → pointsLedger up to periodEnd.
    const outlets = await this.prisma.outlet.findMany({
      where: { partner: { clientId: user.clientId }, deletedAt: null },
      select: {
        id: true,
        name: true,
        outletType: { select: { name: true } },
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

    const rows: PointsLedgerReportRow[] = outlets
      .filter((o) => (o.partner?.wallets?.length ?? 0) > 0)
      .map((o) => {
        const wallet = o.partner!.wallets[0];
        const ledger = wallet.pointsLedger;

        const beforePeriod = ledger.filter((e) => e.createdAt < periodStart);
        const inPeriod = ledger.filter((e) => e.createdAt >= periodStart);

        // Opening balance = net EARN − REDEEM − EXPIRE before period start.
        const openingBalance = beforePeriod.reduce((sum, e) => {
          if (e.transactionType === 'EARN') return sum + e.points;
          if (e.transactionType === 'REDEEM') return sum - e.points;
          if (e.transactionType === 'EXPIRE') return sum - e.points;
          return sum;
        }, 0);

        return aggregateLedgerToRow(
          { outletId: o.id, outletName: o.name, outletType: o.outletType?.name },
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
        createdBy: { select: { name: true } },
        assignedTo: { select: { name: true } },
      },
    });

    const rows: TicketAgingRow[] = tickets.map((t) =>
      buildTicketAgingRow(
        {
          ticketNumber: t.ticketNumber,
          subject: t.subject,
          category: String(t.category),
          priority: String(t.priority),
          status: String(t.status),
          createdByName: t.createdBy?.name ?? 'Unknown',
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
}
