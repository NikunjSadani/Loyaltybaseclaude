import { BadRequestException, Injectable, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma, TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KycService } from '../kyc/kyc.service';
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

// ── Outlet Master (57-column) types & helpers ─────────────────────────────────
const RUNGS = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'] as const;
type Rung = (typeof RUNGS)[number];

/** A SalesUser node as loaded for the assignment chain (recursive reportingTo). */
interface AssignmentSalesUser {
  employeeCode: string;
  hierarchyLevel?: { code: string } | null;
  user?: { name: string | null; phone: string | null } | null;
  reportingTo?: AssignmentSalesUser | null;
}

/** Prisma Decimal | null → string ('' when null). */
function decToStr(d: Prisma.Decimal | null | undefined): string {
  return d == null ? '' : d.toString();
}

/** Date | null → YYYY-MM-DD ('' when null). */
function dateOnly(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().split('T')[0] : '';
}

/** The 57 header keys in exact order — used to seed an empty sheet so headers persist. */
const OUTLET_MASTER_HEADERS: string[] = [
  'Zone', 'Outlet Code', 'Outlet Name', 'Outlet Type', 'Program Name', 'Program Category',
  'Distributor Code', 'Distributor Name', 'Metro', 'Beat', 'Parent ID',
  ...RUNGS.flatMap((r) => [`${r} ID`, `${r} Name`, `${r} Phone Number`]),
  'Owner Name', 'Phone Number', 'Address', 'City', 'State', 'Pincode',
  'Latitude of Outlet Board', 'Longitude of Outlet Board',
  'Enrollment by Employee ID', 'Enrollment by Employee Name', 'Enrollment by Employee Phone Number',
  'Enrollment Date', 'Enrollment Status', 'Profile Status',
  'Approval by Employee ID', 'Approval by Employee Name', 'Approval by Employee Phone Number',
  'Approval by Gifsy', 'Approval Date of Gifsy',
  'Latitude of Bank Details Collection', 'Longitude of Bank Details Collection',
  'Remarks', 'GST', 'PAN', 'GST Certificate', 'Address Proof', 'Self-Declaration', 'Deactivated At',
];

/** A single all-empty row carrying every header key, so an empty export still has the 57 columns. */
function emptyOutletMasterRow(): Record<string, unknown> {
  return Object.fromEntries(OUTLET_MASTER_HEADERS.map((h) => [h, ''] as const));
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly kyc: KycService,
  ) {}

  private isValidYYYYMM(s: string): boolean {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  }

  // ── Outlet Master (57 columns) ──────────────────────────────────────────────
  /**
   * GET /v1/admin/reports/outlet-master — tenant-scoped xlsx with the full
   * 57-column outlet master. Batch-loaded (no N+1): one outlets+partner query,
   * one active-assignment query (with the SalesUser reportingTo chain), one
   * submissions+documents+statusHistory query — then assembled in memory.
   *
   * Doc links (#53-55) are signed doc-view tokens pointed at the FE `/api/*`
   * proxy (→ backend `/v1/*`), so they open without an app login for 30 days.
   */
  async outletMaster(user: JwtPayload, req?: Request): Promise<StreamableFile> {
    const clientId = user.clientId;
    const base = this.externalBase(req);

    // 1) Outlets + partner (1 query). Tenant-scoped.
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId, deletedAt: null },
      select: {
        id: true,
        partnerId: true,
        zone: true,
        outletCode: true,
        name: true,
        outletType: { select: { name: true } },
        programName: true,
        programCategory: true,
        distributorCode: true,
        distributorName: true,
        metro: true,
        beat: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        pincode: true,
        phone: true,
        isActive: true,
        deactivatedAt: true,
        partner: {
          select: {
            ownerName: true,
            phone: true,
            gstNumber: true,
            panNumber: true,
          },
        },
        // Owner-group parent (Outlet.parentId → parent ChannelPartner) — emit its
        // partnerCode so the "Parent ID" column round-trips through the upload (which
        // keys the outlet to a group by the parent's partnerCode).
        parent: {
          select: { partnerCode: true },
        },
      },
      orderBy: { outletCode: 'asc' },
    });

    const outletIds = outlets.map((o) => o.id);
    const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];

    // 2) Active assignments for these outlets + the full SalesUser chain (1 query).
    const assignments = outletIds.length
      ? await this.prisma.salesUserAssignment.findMany({
          where: { outletId: { in: outletIds }, unassignedAt: null },
          select: {
            outletId: true,
            assignedAt: true,
            salesUser: { select: this.salesUserChainSelect() },
          },
          orderBy: { assignedAt: 'desc' },
        })
      : [];

    // Lowest-rung SalesUser per outlet (most-recent active assignment wins).
    const assignmentByOutlet = new Map<string, AssignmentSalesUser>();
    for (const a of assignments) {
      if (!a.outletId || !a.salesUser) continue;
      if (!assignmentByOutlet.has(a.outletId)) {
        assignmentByOutlet.set(a.outletId, a.salesUser as AssignmentSalesUser);
      }
    }

    // 3) Submissions for these partners + their documents + status history (1 query),
    //    newest-first so the first per partner is the "latest".
    const submissions = partnerIds.length
      ? await this.prisma.kycSubmission.findMany({
          where: { partnerId: { in: partnerIds }, user: { clientId } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            partnerId: true,
            status: true,
            submittedAt: true,
            createdAt: true,
            approvedAt: true,
            rejectionReason: true,
            reviewerNotes: true,
            boardPhotoLat: true,
            boardPhotoLng: true,
            paymentLat: true,
            paymentLng: true,
            user: { select: { id: true, name: true, phone: true } },
            documents: {
              select: { id: true, documentType: true, createdAt: true },
              orderBy: { createdAt: 'desc' },
            },
            statusHistory: {
              select: { toStatus: true, changedByUserId: true, createdAt: true, metadata: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        })
      : [];

    // Latest submission per partner.
    const latestSubByPartner = new Map<string, (typeof submissions)[number]>();
    for (const s of submissions) {
      if (!s.partnerId) continue;
      if (!latestSubByPartner.has(s.partnerId)) latestSubByPartner.set(s.partnerId, s);
    }

    // 4) Resolve SalesUser by userId for the enrollment- and approval-employee
    //    lookups (the actor is stored as a User id; we map it to its SalesUser).
    const enrollerUserIds = new Set<string>();
    const approverUserIds = new Set<string>();
    for (const s of latestSubByPartner.values()) {
      if (s.user?.id) enrollerUserIds.add(s.user.id);
      const approver = this.salesApproverHistoryRow(s.statusHistory);
      if (approver?.changedByUserId) approverUserIds.add(approver.changedByUserId);
    }
    const lookupUserIds = [...new Set([...enrollerUserIds, ...approverUserIds])];
    const salesUsersByUserId = lookupUserIds.length
      ? new Map(
          (
            await this.prisma.salesUser.findMany({
              where: { userId: { in: lookupUserIds }, clientId },
              select: {
                userId: true,
                employeeCode: true,
                user: { select: { name: true, phone: true } },
              },
            })
          ).map((su) => [su.userId, su]),
        )
      : new Map();

    // ── Assemble rows ──────────────────────────────────────────────────────────
    const rows: Record<string, unknown>[] = outlets.map((o) => {
      const row: Record<string, unknown> = {};

      // 1-10 outlet master columns.
      row['Zone'] = o.zone ?? '';
      row['Outlet Code'] = o.outletCode ?? '';
      row['Outlet Name'] = o.name ?? '';
      row['Outlet Type'] = o.outletType?.name ?? '';
      row['Program Name'] = o.programName ?? '';
      row['Program Category'] = o.programCategory ?? '';
      row['Distributor Code'] = o.distributorCode ?? '';
      row['Distributor Name'] = o.distributorName ?? '';
      row['Metro'] = o.metro ?? '';
      row['Beat'] = o.beat ?? '';
      // Owner-group parent code (round-trips through the outlet-master upload's "Parent ID").
      row['Parent ID'] = o.parent?.partnerCode ?? '';

      // sales-hierarchy rungs, mapped by hierarchyLevel.code.
      const byRung = this.resolveRungs(assignmentByOutlet.get(o.id));
      for (const rung of RUNGS) {
        const su = byRung[rung];
        row[`${rung} ID`] = su?.employeeCode ?? '';
        row[`${rung} Name`] = su?.user?.name ?? '';
        row[`${rung} Phone Number`] = su?.user?.phone ?? '';
      }

      // 29-34 owner / contact / address.
      row['Owner Name'] = o.partner?.ownerName ?? '';
      row['Phone Number'] = o.partner?.phone ?? o.phone ?? '';
      row['Address'] = [o.addressLine1, o.addressLine2].filter(Boolean).join(', ');
      row['City'] = o.city ?? '';
      row['State'] = o.state ?? '';
      row['Pincode'] = o.pincode ?? '';

      // KYC-submission-sourced columns (latest submission for the outlet's partner).
      const sub = o.partnerId ? latestSubByPartner.get(o.partnerId) : undefined;

      // 35-36 board geo.
      row['Latitude of Outlet Board'] = decToStr(sub?.boardPhotoLat);
      row['Longitude of Outlet Board'] = decToStr(sub?.boardPhotoLng);

      // 37-41 enrollment.
      const enroller = sub?.user?.id ? salesUsersByUserId.get(sub.user.id) : undefined;
      row['Enrollment by Employee ID'] = enroller?.employeeCode ?? '';
      row['Enrollment by Employee Name'] = sub?.user?.name ?? '';
      row['Enrollment by Employee Phone Number'] = sub?.user?.phone ?? '';
      row['Enrollment Date'] = dateOnly(sub?.submittedAt ?? sub?.createdAt);
      row['Enrollment Status'] = sub?.status ?? '';

      // 42 profile status.
      row['Profile Status'] = o.isActive ? 'Active' : 'Deactivated';

      // 43-45 sales approver (the actor who moved the submission to PENDING_GIFSY /
      // sales-side APPROVED). Resolved from KycStatusHistory.changedByUserId.
      const approverRow = sub ? this.salesApproverHistoryRow(sub.statusHistory) : undefined;
      const approver = approverRow?.changedByUserId
        ? salesUsersByUserId.get(approverRow.changedByUserId)
        : undefined;
      row['Approval by Employee ID'] = approver?.employeeCode ?? '';
      row['Approval by Employee Name'] = approver?.user?.name ?? '';
      row['Approval by Employee Phone Number'] = approver?.user?.phone ?? '';

      // 46-47 Gifsy final approval.
      const gifsy = this.gifsyApproval(sub);
      row['Approval by Gifsy'] = gifsy.approved ? 'Yes' : 'No';
      row['Approval Date of Gifsy'] = dateOnly(gifsy.at);

      // 48-49 payment geo.
      row['Latitude of Bank Details Collection'] = decToStr(sub?.paymentLat);
      row['Longitude of Bank Details Collection'] = decToStr(sub?.paymentLng);

      // 50 remarks.
      row['Remarks'] = sub?.rejectionReason ?? sub?.reviewerNotes ?? '';

      // 51-52 GST / PAN.
      row['GST'] = o.partner?.gstNumber ?? '';
      row['PAN'] = o.partner?.panNumber ?? '';

      // 53-55 document links (latest doc per type on the latest submission).
      row['GST Certificate'] = this.docLink(base, clientId, sub, 'GST_CERTIFICATE');
      row['Address Proof'] = this.docLink(base, clientId, sub, 'SHOP_ESTABLISHMENT');
      row['Self-Declaration'] = this.docLink(base, clientId, sub, 'SELF_DECLARATION');

      // 56 deactivated at.
      row['Deactivated At'] = dateOnly(o.deactivatedAt);

      return row;
    });

    // Guarantee the 57 headers exist (and in order) even when outlets is empty:
    // buildXlsx derives the header row from the first object's keys.
    const sheetRows = rows.length ? rows : [emptyOutletMasterRow()];

    const buffer = buildXlsx([{ name: 'Outlet Master', rows: sheetRows }]);
    const today = new Date().toISOString().split('T')[0];
    return new StreamableFile(buffer, {
      type: XLSX_TYPE,
      disposition: `attachment; filename="outlet-master-${today}.xlsx"`,
    });
  }

  // ── Outlet Master helpers ───────────────────────────────────────────────────

  /** External origin for doc links: x-forwarded-proto/host → host → localhost. */
  private externalBase(req?: Request): string {
    const header = (name: string): string | undefined => {
      const v = req?.headers?.[name];
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    };
    const proto = (header('x-forwarded-proto') || 'https').split(',')[0].trim();
    const host = (header('x-forwarded-host') || header('host') || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  /** Prisma select for a SalesUser + its reportingTo chain (deep enough for 6 rungs). */
  private salesUserChainSelect(): Prisma.SalesUserSelect {
    const node: Prisma.SalesUserSelect = {
      employeeCode: true,
      hierarchyLevel: { select: { code: true } },
      user: { select: { name: true, phone: true } },
    };
    // Nest reportingTo to a depth that comfortably covers XSR→SO→ASM→RSM→ZNM→NSM.
    let cur: Prisma.SalesUserSelect = { ...node };
    for (let i = 0; i < 7; i++) {
      cur = { ...node, reportingTo: { select: cur } };
    }
    return cur;
  }

  /**
   * Walk the assigned SalesUser up its reportingTo chain and bucket each node by
   * its hierarchyLevel.code (NOT walk position) so a skipped level leaves its
   * three cells blank rather than shifting everyone.
   */
  private resolveRungs(start?: AssignmentSalesUser): Record<Rung, AssignmentSalesUser | undefined> {
    const out: Record<Rung, AssignmentSalesUser | undefined> = {
      XSR: undefined, SO: undefined, ASM: undefined, RSM: undefined, ZNM: undefined, NSM: undefined,
    };
    let cur: AssignmentSalesUser | undefined | null = start;
    let guard = 0;
    while (cur && guard++ < 20) {
      const code = cur.hierarchyLevel?.code as Rung | undefined;
      if (code && code in out && !out[code]) out[code] = cur;
      cur = cur.reportingTo ?? undefined;
    }
    return out;
  }

  /**
   * The KycStatusHistory row representing the SALES approval that handed the
   * submission to Gifsy. Prefer a FIRST_APPROVER-stage row whose toStatus is
   * PENDING_GIFSY; fall back to any row moving to PENDING_GIFSY; then to a
   * sales-side APPROVED (stage != GIFSY). Returns undefined if none.
   */
  private salesApproverHistoryRow(
    history: { toStatus: string; changedByUserId: string | null; metadata: Prisma.JsonValue | null }[],
  ): { changedByUserId: string | null } | undefined {
    const stageOf = (m: Prisma.JsonValue | null): string | undefined =>
      m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>).stage as string : undefined;

    return (
      history.find((h) => h.toStatus === 'PENDING_GIFSY' && stageOf(h.metadata) === 'FIRST_APPROVER') ||
      history.find((h) => h.toStatus === 'PENDING_GIFSY') ||
      history.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) !== 'GIFSY')
    );
  }

  /** Gifsy final-approval state + timestamp for a submission. */
  private gifsyApproval(sub?: {
    status: string;
    approvedAt: Date | null;
    statusHistory: { toStatus: string; createdAt: Date; metadata: Prisma.JsonValue | null }[];
  }): { approved: boolean; at: Date | null } {
    if (!sub) return { approved: false, at: null };
    const stageOf = (m: Prisma.JsonValue | null): string | undefined =>
      m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>).stage as string : undefined;
    const gifsyRow =
      sub.statusHistory.find((h) => h.toStatus === 'APPROVED' && stageOf(h.metadata) === 'GIFSY') ||
      sub.statusHistory.find((h) => h.toStatus === 'APPROVED');
    if (sub.status === 'APPROVED' || gifsyRow) {
      return { approved: true, at: gifsyRow?.createdAt ?? sub.approvedAt ?? null };
    }
    return { approved: false, at: null };
  }

  /** Signed doc-view link for the latest document of `type` on the submission, or ''. */
  private docLink(
    base: string,
    clientId: string,
    sub: { documents: { id: string; documentType: string }[] } | undefined,
    type: string,
  ): string {
    const doc = sub?.documents.find((d) => d.documentType === type);
    if (!doc) return '';
    return `${base}/api/kyc/documents/view?token=${this.kyc.signDocViewToken(doc.id, clientId)}`;
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
