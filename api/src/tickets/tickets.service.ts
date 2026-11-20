import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketNoteVisibility, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator } from '../common/tenant-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import {
  AddMessageDto,
  AssignTicketDto,
  CancelClientRemarksDto,
  ClientRemarksReplyDto,
  CreateTicketDto,
  EscalateTicketDto,
  ListTicketsQueryDto,
  RequestClientRemarksDto,
  SetTicketStatusDto,
  SETTABLE_TICKET_STATUSES,
} from './dto/tickets.dto';
import { escapeHtml, pickTenantDomain, ticketEmailLink, ticketPath } from './ticket-link';
import { TICKET_REMARKS_EMAIL_KEY, readTicketRemarksEmail } from './ticket-remarks-inbox';
import {
  OUTLET_REFERENCE_TYPE,
  PARTNER_ROLES,
  TICKET_CREATOR_SELECT,
  TICKET_SENDER_SELECT,
  describeRaisedBy,
  resolveTicketOutlet,
} from './ticket-submitter';
import { loadSalesHierarchy } from '../sales/sales-hierarchy.loader';
import { descendantSalesUserIds } from '../sales/sales-hierarchy-access.helper';

/** Human-readable labels for the system message posted on a status change. */
const STATUS_ACTION_LABEL: Record<string, string> = {
  RESOLVED: 'marked Resolved',
  CLOSED: 'Closed',
  IN_PROGRESS: 'Reopened',
  OPEN: 'Reopened',
};

/** The Gifsy platform operators' home tenant (owner + staff live here). */
const GIFSY_HOME_CLIENT_ID = 'gifsy';

/** Support-internal states a field (outlet / sales) reader sees as plain IN_PROGRESS. */
const FIELD_MASKED_STATUSES: TicketStatus[] = ['WAITING_ON_CLIENT', 'ESCALATED'];

/**
 * The pending "remarks requested from a client admin" marker, stored at
 * Ticket.metadata.clientRemarks while status = WAITING_ON_CLIENT. Support-admin-only data:
 * never selected for an outlet/sales read.
 */
export interface ClientRemarksRequest {
  requestedFromId: string;
  requestedFromName: string;
  requestedById: string;
  requestedByName: string;
  note: string;
  requestedAt: string;
  /** The status before the request — restored on reply when it was ESCALATED. */
  fromStatus?: string;
}

/** One person a ticket may be assigned / escalated / sent to. */
export interface TicketAssignee {
  id: string;
  name: string;
  role: string;
  kind: 'GIFSY' | 'CLIENT_ADMIN';
}

type TicketMeta = Record<string, unknown> & { clientRemarks?: ClientRemarksRequest | null };

/**
 * ONE rule for where a ticket goes when a remarks request ends — whether the client admin replied
 * or Gifsy withdrew it: ESCALATED stays ESCALATED and PENDING_USER (waiting on the outlet) stays
 * PENDING_USER — those states are about something else and the request didn't change them;
 * everything else (OPEN, IN_PROGRESS, unknown) resumes as IN_PROGRESS — asking the client was
 * already support work, so the ticket is no longer untouched/OPEN.
 */
export function resumeStatusAfterRemarks(fromStatus: string | undefined | null): TicketStatus {
  return fromStatus === 'ESCALATED' || fromStatus === 'PENDING_USER' ? fromStatus : 'IN_PROGRESS';
}

function readMeta(metadata: unknown): TicketMeta {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as TicketMeta) } : {};
}

/** The metadata with the pending client-remarks marker removed (other keys preserved). */
function withoutRemarks(metadata: unknown): Prisma.InputJsonValue {
  const m = readMeta(metadata);
  delete m.clientRemarks;
  return m as Prisma.InputJsonValue;
}

type Reader = 'GIFSY' | 'CLIENT' | 'FIELD';

/** The client-visible cancellation note (neutral unless a client-safe reason is given). */
function cancellationText(requestedFromName: string, clientReason?: string): string {
  return clientReason
    ? `Gifsy support has withdrawn the request for remarks from ${requestedFromName} — ${clientReason}.`
    : `Gifsy support has withdrawn the request for remarks from ${requestedFromName}.`;
}

/** Tenant-wide stat-card counts for the admin list. */
export interface TicketSummary {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  highPriority: number;
}

/**
 * Field (outlet / sales) projection — an explicit allow-list so the assignee, priority, the
 * remarks marker (metadata) and any future admin-only column are never even selected.
 */
const FIELD_TICKET_SELECT = {
  id: true,
  clientId: true,
  ticketNumber: true,
  createdById: true,
  category: true,
  status: true,
  subject: true,
  description: true,
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true, phone: true } },
} as const satisfies Prisma.TicketSelect;

/** A ticket row as loaded for an action (all scalars). */
type TicketRow = Prisma.TicketGetPayload<object>;

/**
 * Support tickets — ported from platform/src/app/api/tickets/* (S4 pilot).
 * Tenant-scoped by clientId (from the session-bound JWT). Admin roles
 * (GIFSY_ADMIN / GIFSY_STAFF / CLIENT_ADMIN / MIS_USER) see + manage ALL tickets in their
 * tenant; field roles (sales chain, partners) see/act on only the tickets they created.
 *
 * Assign / escalate / client-remarks (2026-11-19, SUPPORT-TICKETS.md). Three reader classes:
 *  - GIFSY  (GIFSY_ADMIN / GIFSY_STAFF): everything;
 *  - CLIENT (CLIENT_ADMIN / MIS_USER, the tenant's desk): all non-internal messages + internal
 *    notes that are SHARED_WITH_CLIENT or legacy (NULL visibility) — never GIFSY_ONLY notes;
 *  - FIELD  (outlet / sales raiser): non-internal messages only, an allow-listed projection
 *    (no assignee / priority / metadata), WAITING_ON_CLIENT + ESCALATED masked as IN_PROGRESS.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
  ) {}

  /** Support desk = may see / manage every ticket of the tenant. */
  private isSupportAdmin(user: JwtPayload): boolean {
    return this.reader(user) !== 'FIELD';
  }

  private reader(user: JwtPayload): Reader {
    if (user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF') return 'GIFSY';
    if (user.role === 'CLIENT_ADMIN' || user.role === 'MIS_USER') return 'CLIENT';
    return 'FIELD';
  }

  /** The message filter for a reader class (undefined = all). NULL-safe OR (Prisma `not` drops NULLs). */
  private messageWhere(reader: Reader): Prisma.TicketMessageWhereInput | undefined {
    if (reader === 'GIFSY') return undefined;
    if (reader === 'FIELD') return { isInternal: false };
    return {
      OR: [{ isInternal: false }, { internalVisibility: null }, { internalVisibility: 'SHARED_WITH_CLIENT' }],
    };
  }

  /**
   * Field readers: mask support-internal states, and (belt-and-braces on top of the allow-listed
   * select) drop every admin-only key should one ever be added to the projection.
   */
  private maskForField<T extends Record<string, unknown>>(row: T): T {
    const out: Record<string, unknown> = { ...row };
    for (const k of ['metadata', 'assignedTo', 'assignedToId', 'priority', 'referenceType', 'referenceId']) delete out[k];
    if (FIELD_MASKED_STATUSES.includes(out.status as TicketStatus)) out.status = 'IN_PROGRESS';
    return out as T;
  }

  /**
   * Support-admin reads: attach `raisedBy` (outlet owner vs sales person + designation) and
   * `outlet` (id / outletCode / name, or null = "—") — see ticket-submitter.ts for the rules.
   * Referenced outlets are batch-loaded, tenant-pinned (one query per page, no N+1). Messages
   * (when loaded) get a `senderLabel` / `senderKind` so the thread says who wrote each one.
   */
  private async withSubmitter(clientId: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const refIds = [
      ...new Set(
        rows
          .filter((r) => r.referenceType === OUTLET_REFERENCE_TYPE && typeof r.referenceId === 'string')
          .map((r) => r.referenceId as string),
      ),
    ];
    const outlets = refIds.length
      ? await this.prisma.outlet.findMany({
          where: { id: { in: refIds }, clientId },
          select: { id: true, outletCode: true, name: true },
        })
      : [];
    const byId = new Map((outlets ?? []).map((o) => [o.id, o]));
    return rows.map((r) => {
      const creator = r.createdBy as Parameters<typeof describeRaisedBy>[0];
      const out: Record<string, unknown> = {
        ...r,
        raisedBy: describeRaisedBy(creator),
        outlet: resolveTicketOutlet(
          { referenceType: r.referenceType as string | null, referenceId: r.referenceId as string | null },
          creator as never,
          byId,
        ),
      };
      if (Array.isArray(r.messages)) {
        out.messages = (r.messages as Record<string, unknown>[]).map((m) => {
          const who = describeRaisedBy(m.sender as Parameters<typeof describeRaisedBy>[0]);
          return { ...m, senderLabel: who.label, senderKind: who.kind };
        });
      }
      return out;
    });
  }

  /**
   * Validates the optional outlet a raiser attaches at create: a sales person may name only an
   * outlet assigned anywhere in their own downline (same walk as their outlets list); an outlet
   * owner only one of their own outlets; an admin any outlet of their tenant. Throws 400 otherwise.
   */
  private async assertOutletForRaiser(user: JwtPayload, outletId: string): Promise<void> {
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: outletId, clientId: user.clientId, deletedAt: null },
      select: { id: true, partnerId: true },
    });
    let ok = !!outlet;
    if (ok && user.role.startsWith('SALES_')) {
      const me = await this.prisma.salesUser.findFirst({
        where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
        select: { id: true },
      });
      if (!me) ok = false;
      else {
        const subtree = [...descendantSalesUserIds(me.id, await loadSalesHierarchy(this.prisma, user.clientId))];
        const assigned = await this.prisma.salesUserAssignment.findFirst({
          where: { salesUserId: { in: subtree }, outletId, unassignedAt: null },
          select: { id: true },
        });
        ok = !!assigned;
      }
    } else if (ok && PARTNER_ROLES.has(user.role)) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { userId: user.sub, clientId: user.clientId },
        select: { id: true },
      });
      ok = !!partner && outlet!.partnerId === partner.id;
    } else if (ok && !this.isSupportAdmin(user)) {
      ok = false;
    }
    if (!ok) {
      throw new BadRequestException(
        'That outlet is not (or no longer) assigned to you or your team — pick another outlet or raise it as your own issue.',
      );
    }
  }

  /**
   * Support-admin list filters, evaluated in the DB so they cover EVERY ticket (not just a loaded
   * page): priorities (comma list), source (outlet owner vs sales rep), and free-text `q` over ticket
   * number, subject, the raiser's name, and outlet name / code (the owner's outlets, or the outlet a
   * sales ticket references — resolved to ids first, tenant-pinned).
   */
  private async adminListFilters(user: JwtPayload, q: ListTicketsQueryDto): Promise<Prisma.TicketWhereInput> {
    const and: Prisma.TicketWhereInput[] = [];
    if (q.priorities) {
      const valid: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const list = q.priorities.split(',').map((p) => p.trim().toUpperCase()).filter((p): p is TicketPriority => valid.includes(p as TicketPriority));
      if (list.length === 0) throw new BadRequestException(`Invalid priorities '${q.priorities}'`);
      and.push({ priority: { in: list } });
    }
    if (q.source === 'outlet') and.push({ createdBy: { role: { in: [...PARTNER_ROLES] as never[] } } });
    if (q.source === 'sales') {
      and.push({ createdBy: { role: { in: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'] } } });
    }
    const text = q.q?.trim();
    if (text) {
      const contains = { contains: text, mode: 'insensitive' as const };
      // Tickets that REFERENCE a matching outlet (sales "For an Outlet"): resolved with one join in the
      // DB, so the match is exact and uncapped. The result is bounded by the tenant's referencing
      // TICKETS (never by how many outlets match the text).
      const like = `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const refRows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT t."id" FROM "tickets" t
        JOIN "outlets" o ON o."id" = t."referenceId" AND o."clientId" = t."clientId"
        WHERE t."clientId" = ${user.clientId}
          AND t."referenceType" = ${OUTLET_REFERENCE_TYPE}
          AND (o."outletCode" ILIKE ${like} OR o."name" ILIKE ${like})`);
      const refTicketIds = (Array.isArray(refRows) ? refRows : []).map((r) => r.id);
      and.push({
        OR: [
          { ticketNumber: contains },
          { subject: contains },
          { createdBy: { name: contains } },
          { createdBy: { channelPartner: { ownerName: contains } } },
          { createdBy: { channelPartner: { outlets: { some: { OR: [{ outletCode: contains }, { name: contains }] } } } } },
          ...(refTicketIds.length ? [{ id: { in: refTicketIds } }] : []),
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }

  /** Tenant-wide counts for the admin stat cards (independent of paging / filters). */
  private async summary(clientId: string): Promise<TicketSummary> {
    const [byStatus, highOpen] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], where: { clientId, deletedAt: null }, _count: { _all: true } }),
      this.prisma.ticket.count({
        where: { clientId, deletedAt: null, priority: { in: ['HIGH', 'CRITICAL'] }, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      }),
    ]);
    const n = (st: TicketStatus[]) =>
      (Array.isArray(byStatus) ? byStatus : []).filter((r) => st.includes(r.status as TicketStatus)).reduce((a, r) => a + (r._count?._all ?? 0), 0);
    return {
      total: n(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED', 'WAITING_ON_CLIENT']),
      open: n(['OPEN']),
      inProgress: n(['IN_PROGRESS', 'ESCALATED', 'WAITING_ON_CLIENT', 'PENDING_USER']),
      resolved: n(['RESOLVED', 'CLOSED']),
      highPriority: highOpen ?? 0,
    };
  }

  async list(user: JwtPayload, q: ListTicketsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const reader = this.reader(user);
    // Soft-deleted tickets are never listed or counted (same rule as the aging report / ops dashboard).
    const where: Prisma.TicketWhereInput = { clientId: user.clientId, deletedAt: null };
    // Field roles see only their own tickets; support admins see all tenant tickets.
    if (reader === 'FIELD') where.createdById = user.sub;
    if (q.status) {
      if (reader !== 'FIELD') {
        where.status = q.status;
      } else if (q.status === 'IN_PROGRESS') {
        // A field reader sees the masked states as IN_PROGRESS, so its filter must match them too.
        where.status = { in: ['IN_PROGRESS', ...FIELD_MASKED_STATUSES] };
      } else if (FIELD_MASKED_STATUSES.includes(q.status)) {
        // ...and the support-internal states themselves never match for them (no existence leak).
        where.status = { in: [] };
      } else {
        where.status = q.status;
      }
    }
    if (q.category) where.category = q.category;
    if (reader !== 'FIELD') Object.assign(where, await this.adminListFilters(user, q));
    if (q.awaitingMine === 'true' && user.role === 'CLIENT_ADMIN') {
      where.status = 'WAITING_ON_CLIENT';
      where.metadata = { path: ['clientRemarks', 'requestedFromId'], equals: user.sub };
    }

    // The message-count badge counts only what this reader could open.
    const mw = this.messageWhere(reader);
    const messagesCount: Prisma.TicketCountOutputTypeSelect['messages'] = mw ? { where: mw } : true;

    const findArgs =
      reader === 'FIELD'
        ? { where, select: { ...FIELD_TICKET_SELECT, _count: { select: { messages: messagesCount } } } }
        : {
            where,
            include: {
              createdBy: { select: TICKET_CREATOR_SELECT },
              assignedTo: { select: { id: true, name: true } },
              _count: { select: { messages: messagesCount } },
            },
          };
    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        ...(findArgs as Prisma.TicketFindManyArgs),
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    const rows = (tickets ?? []) as unknown as Record<string, unknown>[];
    const result: {
      tickets: unknown[];
      pagination: { page: number; limit: number; total: number; pages: number };
      awaitingClient?: { total: number; mine: number };
      summary?: TicketSummary;
    } = {
      tickets: reader === 'FIELD' ? rows.map((t) => this.maskForField(t)) : await this.withSubmitter(user.clientId, rows),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };

    // Support admins get the tenant-wide "awaiting client" count (independent of paging /
    // filters) + how many of those wait on THIS caller (a CLIENT_ADMIN's "awaiting your remarks").
    // Counts are tenant-wide and identical for every page — computed once, on page 1 only.
    if (reader !== 'FIELD' && page === 1) {
      const base: Prisma.TicketWhereInput = { clientId: user.clientId, deletedAt: null, status: 'WAITING_ON_CLIENT' };
      const [awaitTotal, awaitMine] = await Promise.all([
        this.prisma.ticket.count({ where: base }),
        user.role === 'CLIENT_ADMIN'
          ? this.prisma.ticket.count({
              where: { ...base, metadata: { path: ['clientRemarks', 'requestedFromId'], equals: user.sub } },
            })
          : Promise.resolve(0),
      ]);
      result.awaitingClient = { total: awaitTotal ?? 0, mine: awaitMine ?? 0 };
      result.summary = await this.summary(user.clientId);
    }

    return result;
  }

  async create(user: JwtPayload, dto: CreateTicketDto) {
    if (dto.outletId) await this.assertOutletForRaiser(user, dto.outletId);
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
    const data: Prisma.TicketUncheckedCreateInput = {
      ticketNumber,
      category: dto.category,
      subject: dto.subject,
      description: dto.description,
      status: 'OPEN',
      priority: 'MEDIUM',
      createdById: user.sub,
      clientId: user.clientId,
      ...(dto.outletId ? { referenceType: OUTLET_REFERENCE_TYPE, referenceId: dto.outletId } : {}),
      messages: {
        create: { message: dto.description, senderId: user.sub, isInternal: false },
      },
    };
    const ticket = this.isSupportAdmin(user)
      ? await this.prisma.ticket.create({ data, include: { messages: true } })
      : await this.prisma.ticket.create({
          data,
          select: { ...FIELD_TICKET_SELECT, messages: { where: { isInternal: false } } },
        });
    return { ticket };
  }

  /** Loads a ticket within the caller's tenant + access scope, or throws. */
  private async assertAccess(user: JwtPayload, ticket: { createdById: string } | null) {
    if (!ticket) throw new NotFoundException('Ticket not found');
    // Support admins can open any ticket in their tenant; field roles only their own.
    if (!this.isSupportAdmin(user) && ticket.createdById !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }
  }

  async getOne(user: JwtPayload, id: string) {
    const reader = this.reader(user);
    const mw = this.messageWhere(reader);

    if (reader === 'FIELD') {
      // Security: internal notes and client remarks never reach the raiser — filtered at the DB.
      const ticket = await this.prisma.ticket.findFirst({
        where: { id, clientId: user.clientId },
        select: {
          ...FIELD_TICKET_SELECT,
          messages: {
            where: mw,
            include: { sender: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      await this.assertAccess(user, ticket);
      return { ticket: this.maskForField(ticket as unknown as Record<string, unknown>) };
    }

    const messages: Prisma.Ticket$messagesArgs = {
      include: { sender: { select: TICKET_SENDER_SELECT } },
      orderBy: { createdAt: 'asc' },
      ...(mw ? { where: mw } : {}),
    };
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, clientId: user.clientId },
      include: {
        createdBy: { select: TICKET_CREATOR_SELECT },
        assignedTo: { select: { id: true, name: true } },
        messages,
      },
    });
    await this.assertAccess(user, ticket);
    const [enriched] = await this.withSubmitter(user.clientId, [ticket as unknown as Record<string, unknown>]);
    return { ticket: enriched };
  }

  // ─── Assign / escalate / client remarks ──────────────────────────────────────

  /** Gifsy-operator-only guard (defense in depth; the controller @Roles-gates too). */
  private assertGifsyOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) throw new ForbiddenException('Only Gifsy support can do this');
  }

  /** A ticket in the caller's (assumed) tenant, or 404. */
  private async loadTenantTicket(user: JwtPayload, id: string): Promise<TicketRow> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket as TicketRow;
  }

  /** Optimistic guard: the row must be unchanged since `ticket` was read. */
  private unchangedSince(user: JwtPayload, ticket: TicketRow): Prisma.TicketWhereInput {
    return { id: ticket.id, clientId: user.clientId, status: ticket.status, updatedAt: ticket.updatedAt };
  }

  private static readonly CONFLICT = 'The ticket changed meanwhile — reload and try again';

  /**
   * Everyone a ticket of tenant `clientId` may be assigned to:
   *  - active Gifsy OWNERs (GIFSY_ADMIN at the gifsy home tenant — may operate on any tenant);
   *  - active GIFSY_STAFF holding a GifsyStaffTenantGrant for THIS tenant AND a live GifsyRole
   *    with support:read (deny-by-default: otherwise they could not open the ticket);
   *  - active CLIENT_ADMINs of THIS tenant only (never another tenant's).
   */
  private async assignableUsers(clientId: string): Promise<TicketAssignee[]> {
    const active = { status: 'ACTIVE' as const, deletedAt: null };
    const select = { id: true, name: true, role: true } as const;
    const [owners, staff, clientAdmins] = await Promise.all([
      this.prisma.user.findMany({ where: { ...active, role: 'GIFSY_ADMIN', clientId: GIFSY_HOME_CLIENT_ID }, select, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({
        where: {
          ...active,
          role: 'GIFSY_STAFF',
          clientId: GIFSY_HOME_CLIENT_ID,
          gifsyTenantGrants: { some: { clientId } },
          gifsyRole: { deletedAt: null, permissions: { has: 'support:read' } },
        },
        select,
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({ where: { ...active, role: 'CLIENT_ADMIN', clientId }, select, orderBy: { name: 'asc' } }),
    ]);
    return [
      ...[...(owners ?? []), ...(staff ?? [])].map((u) => ({ id: u.id, name: u.name, role: String(u.role), kind: 'GIFSY' as const })),
      ...(clientAdmins ?? []).map((u) => ({ id: u.id, name: u.name, role: String(u.role), kind: 'CLIENT_ADMIN' as const })),
    ];
  }

  /** GET :id/assignees — the picker options for a ticket (Gifsy operators only). */
  async listAssignees(user: JwtPayload, id: string) {
    this.assertGifsyOperator(user);
    const ticket = await this.loadTenantTicket(user, id);
    return { assignees: await this.assignableUsers(ticket.clientId) };
  }

  /** Resolve `userId` against the ticket's assignable set, or throw a clear 400. */
  private async resolveAssignee(clientId: string, userId: string, kind?: TicketAssignee['kind']) {
    const match = (await this.assignableUsers(clientId)).find((u) => u.id === userId);
    if (!match || (kind && match.kind !== kind)) {
      const who =
        kind === 'CLIENT_ADMIN'
          ? "an active client admin of this ticket's programme"
          : kind === 'GIFSY'
            ? 'an active Gifsy support user who can work on this programme'
            : "Gifsy support or a client admin of this ticket's programme";
      throw new BadRequestException(`User '${userId}' is not ${who}`);
    }
    return match;
  }

  /** The caller's display name (JWT name, else DB). */
  private async actorName(user: JwtPayload): Promise<string> {
    if (user.name) return user.name;
    const u = await this.prisma.user.findFirst({ where: { id: user.sub }, select: { name: true } });
    return u?.name ?? 'Gifsy support';
  }

  /** An internal note with an explicit visibility. */
  private note(ticketId: string, senderId: string, message: string, visibility: TicketNoteVisibility) {
    return { ticketId, senderId, message, isInternal: true, internalVisibility: visibility };
  }

  /**
   * If `ticket` has a pending remarks request, records its cancellation INSIDE `tx` (a
   * SHARED_WITH_CLIENT note — the client admin sees why it went away). Returns the cancelled
   * request so the caller bells the client admin AFTER commit (see bellCancelled).
   */
  private async recordRemarksCancelled(
    tx: Prisma.TransactionClient,
    ticket: TicketRow,
    actorId: string,
    /** Client-safe reason (shown to the client desk) — never internal Gifsy detail. Omit for the neutral text. */
    clientReason?: string,
  ): Promise<ClientRemarksRequest | null> {
    const pending = ticket.status === 'WAITING_ON_CLIENT' ? (readMeta(ticket.metadata).clientRemarks ?? null) : null;
    if (!pending) return null;
    await tx.ticketMessage.create({
      data: this.note(ticket.id, actorId, cancellationText(pending.requestedFromName, clientReason), 'SHARED_WITH_CLIENT'),
    });
    return pending;
  }

  private async bellCancelled(ticket: TicketRow, cancelled: ClientRemarksRequest | null, clientReason?: string) {
    if (!cancelled) return;
    await this.notifications.writeInApp({
      userId: cancelled.requestedFromId,
      subject: `Remarks no longer needed on ticket ${ticket.ticketNumber}`,
      body: clientReason
        ? `Gifsy support has withdrawn the request for your remarks — ${clientReason}.`
        : 'Gifsy support has withdrawn the request for your remarks.',
      url: ticketPath(ticket.id),
      variables: { event: 'TICKET_CLIENT_REMARKS_CANCELLED', ticketId: ticket.id },
    });
  }

  /**
   * POST :id/assign — assign (or unassign with `assigneeId: null`). Gifsy operators only.
   * Writes a GIFSY_ONLY internal note ("Assigned to X by Y") + an audit row; bells the new
   * assignee (in-app only, never email).
   */
  async assign(user: JwtPayload, id: string, dto: AssignTicketDto) {
    this.assertGifsyOperator(user);
    if (dto.assigneeId === undefined) {
      throw new BadRequestException('assigneeId is required (send null to unassign)');
    }
    const ticket = await this.loadTenantTicket(user, id);
    if (ticket.status === 'CLOSED') throw new BadRequestException('Cannot reassign a closed ticket');

    const assignee = dto.assigneeId === null ? null : await this.resolveAssignee(ticket.clientId, dto.assigneeId);
    if ((assignee?.id ?? null) === (ticket.assignedToId ?? null)) {
      return { message: 'No change', assignedTo: assignee };
    }
    const by = await this.actorName(user);
    const text = assignee ? `Assigned to ${assignee.name} by ${by}.` : `Unassigned by ${by}.`;

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.ticket.updateMany({
        where: this.unchangedSince(user, ticket),
        data: { assignedToId: assignee?.id ?? null, updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException(TicketsService.CONFLICT);
      await tx.ticketMessage.create({ data: this.note(id, user.sub, text, 'GIFSY_ONLY') });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: assignee ? 'ASSIGN' : 'UNASSIGN', from: ticket.assignedToId ?? null, to: assignee?.id ?? null },
        },
      });
    });

    if (assignee && assignee.id !== user.sub) {
      await this.notifications.writeInApp({
        userId: assignee.id,
        subject: `Ticket ${ticket.ticketNumber} assigned to you`,
        body: `${by} assigned "${ticket.subject}" to you.`,
        url: ticketPath(id),
        variables: { event: 'TICKET_ASSIGNED', ticketId: id },
      });
    }
    return { message: text, assignedTo: assignee };
  }

  /**
   * POST :id/escalate — internal escalation to a Gifsy operator the caller picks: priority
   * bump (default HIGH) + ESCALATED + the target becomes the assignee. No longer requires a
   * prior assignment. Client admins are NOT escalation targets — involving the client goes
   * through requestClientRemarks. A pending remarks request is CANCELLED explicitly (shared
   * note + bell to the client admin), never silently dropped.
   */
  async escalate(user: JwtPayload, id: string, dto: EscalateTicketDto) {
    this.assertGifsyOperator(user);
    const ticket = await this.loadTenantTicket(user, id);
    if (ticket.status === 'CLOSED') throw new BadRequestException('Cannot escalate a closed ticket');

    // Target must be a Gifsy operator who may work on THIS ticket's tenant (GLm-2: never a
    // foreign / cross-tenant user id).
    const target = await this.resolveAssignee(ticket.clientId, dto.escalateTo, 'GIFSY');
    const priority: TicketPriority = dto.priority ?? 'HIGH';
    const by = await this.actorName(user);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.ticket.updateMany({
        where: this.unchangedSince(user, ticket),
        data: {
          status: 'ESCALATED',
          priority,
          assignedToId: target.id,
          metadata: withoutRemarks(ticket.metadata),
          updatedAt: new Date(),
        },
      });
      if (moved.count !== 1) throw new ConflictException(TicketsService.CONFLICT);
      const c = await this.recordRemarksCancelled(tx, ticket, user.sub);
      await tx.ticketMessage.create({
        data: this.note(
          id,
          user.sub,
          `Ticket escalated to ${target.name} by ${by} (priority ${priority}). Reason: ${dto.reason}${c ? ` — this withdrew the pending remarks request to ${c.requestedFromName}.` : ''}`,
          'GIFSY_ONLY',
        ),
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'ESCALATE', escalateTo: target.id, reason: dto.reason, priority, cancelledRemarksFrom: c?.requestedFromId ?? null },
        },
      });
      return c;
    });

    await this.bellCancelled(ticket, cancelled);
    if (target.id !== user.sub) {
      await this.notifications.writeInApp({
        userId: target.id,
        subject: `Ticket ${ticket.ticketNumber} escalated to you`,
        body: `${by} escalated "${ticket.subject}" (priority ${priority}). Reason: ${dto.reason}`,
        url: ticketPath(id),
        variables: { event: 'TICKET_ESCALATED', ticketId: id },
      });
    }
    return {
      message: 'Ticket escalated successfully',
      escalatedTo: target,
      // Surfaced so the UI can say so — a withdrawn request is never silent.
      cancelledRemarksFrom: cancelled ? cancelled.requestedFromName : null,
    };
  }

  /**
   * POST :id/request-client-remarks — a Gifsy operator asks one of the ticket tenant's
   * CLIENT_ADMINs for remarks. → status WAITING_ON_CLIENT, marker (incl. the previous status) in
   * metadata.clientRemarks, SHARED internal note, audit; then (after commit) bell + email.
   *
   * Idempotent: a request already pending for the SAME client admin is reported back
   * (`alreadyPending`), never re-sent (a retry after a timeout can't double-email). Asking a
   * DIFFERENT client admin replaces the request and cancels the old one explicitly.
   *
   * Email: sent AFTER commit, IN the request (bounded by Msg91Service's 10 s connect / 20 s socket
   * caps — a background send can be lost when Cloud Run throttles CPU after the response). The
   * response carries `emailSent` + `emailError`; the outcome is also written to the thread as a
   * Gifsy-only note. A retried click hits the idempotency guard above, so it never re-sends.
   */
  async requestClientRemarks(user: JwtPayload, id: string, dto: RequestClientRemarksDto, callerOrigin: string) {
    this.assertGifsyOperator(user);
    const ticket = await this.loadTenantTicket(user, id);
    if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') {
      throw new BadRequestException('Reopen the ticket before asking the client for remarks');
    }
    const text = dto.note.trim();
    if (!text) throw new BadRequestException('Describe what you need from the client admin');

    const target = await this.resolveAssignee(ticket.clientId, dto.clientAdminId, 'CLIENT_ADMIN');
    const pending = ticket.status === 'WAITING_ON_CLIENT' ? (readMeta(ticket.metadata).clientRemarks ?? null) : null;
    if (pending && pending.requestedFromId === target.id) {
      return {
        message: `A remarks request to ${target.name} is already pending (since ${pending.requestedAt}) — not sent again`,
        alreadyPending: true,
        requestedFrom: target,
      };
    }

    const by = await this.actorName(user);
    const request: ClientRemarksRequest = {
      requestedFromId: target.id,
      requestedFromName: target.name,
      requestedById: user.sub,
      requestedByName: by,
      note: text,
      requestedAt: new Date().toISOString(),
      // A re-request keeps the ORIGINAL pre-remarks status (never "WAITING_ON_CLIENT").
      fromStatus: pending?.fromStatus ?? ticket.status,
    };
    const metadata = { ...readMeta(ticket.metadata), clientRemarks: request } as unknown as Prisma.InputJsonValue;
    const replacedReason = `asked ${target.name} instead`;

    const replaced = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.ticket.updateMany({
        where: this.unchangedSince(user, ticket),
        data: { status: 'WAITING_ON_CLIENT', metadata, updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException(TicketsService.CONFLICT);
      const c = await this.recordRemarksCancelled(tx, ticket, user.sub, replacedReason);
      await tx.ticketMessage.create({
        data: this.note(id, user.sub, `Remarks requested from ${target.name} (client admin) by ${by}: ${text}`, 'SHARED_WITH_CLIENT'),
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'REQUEST_CLIENT_REMARKS', requestedFromId: target.id, fromStatus: ticket.status, note: text },
        },
      });
      return c;
    });

    await this.bellCancelled(ticket, replaced, replacedReason);
    // Bell (in-app) — best-effort by contract (writeInApp never throws).
    await this.notifications.writeInApp({
      userId: target.id,
      subject: `Your remarks are needed on ticket ${ticket.ticketNumber}`,
      body: `${by} (Gifsy support) asked: ${text}`,
      url: ticketPath(id),
      variables: { event: 'TICKET_CLIENT_REMARKS_REQUESTED', ticketId: id },
    });

    const email = await this.sendRemarksEmail({ ticket, targetId: target.id, targetName: target.name, by, note: text, callerOrigin, actorId: user.sub });
    return {
      message: `Remarks requested from ${target.name}`,
      requestedFrom: target,
      emailSent: email.sent,
      ...(email.sent ? {} : { emailError: email.reason }),
    };
  }

  /** Records an email outcome as a Gifsy-only internal note (never throws). */
  private async recordEmailOutcome(ticketId: string, actorId: string, text: string) {
    try {
      await this.prisma.ticketMessage.create({ data: this.note(ticketId, actorId, text, 'GIFSY_ONLY') });
    } catch (e) {
      this.logger.warn(`[tickets] could not record email outcome on ${ticketId}: ${e}`);
    }
  }

  private async sendRemarksEmail(p: {
    ticket: TicketRow;
    targetId: string;
    targetName: string;
    by: string;
    note: string;
    callerOrigin: string;
    actorId: string;
  }): Promise<{ sent: true } | { sent: false; reason: string }> {
    const notSent = async (reason: string) => {
      await this.recordEmailOutcome(p.ticket.id, p.actorId, `Email to ${p.targetName} was NOT sent: ${reason}. They were notified in-app only.`);
      return { sent: false as const, reason };
    };
    // Each prep step reports its OWN failure — a lookup error is never passed off as "no email on file".
    // Recipient: the client's shared "ticket remarks email" when one is set (ONLY that address — the
    // chosen admin is named in the body and still gets the bell); otherwise the chosen admin's own email.
    let to = '';
    let toInbox = false;
    try {
      const inboxRow = await this.prisma.programSetting.findUnique({
        where: { clientId_settingKey: { clientId: p.ticket.clientId, settingKey: TICKET_REMARKS_EMAIL_KEY } },
        select: { settingValue: true },
      });
      const inbox = readTicketRemarksEmail(inboxRow?.settingValue);
      if (inbox) {
        to = inbox;
        toInbox = true;
      } else {
        const u = await this.prisma.user.findFirst({ where: { id: p.targetId }, select: { email: true } });
        to = (u?.email ?? '').trim();
      }
    } catch (e) {
      this.logger.error(`[tickets] remarks email recipient lookup for ${p.ticket.id} failed: ${e}`);
      return notSent('the email recipient could not be looked up (database error)');
    }
    if (!to) return notSent('the client admin has no email address on file');
    let link = '';
    let linkNote: string | null = null;
    try {
      const rows = await this.prisma.clientDomain.findMany({
        where: { clientId: p.ticket.clientId },
        select: { domain: true, isPrimary: true },
      });
      const picked = pickTenantDomain(Array.isArray(rows) ? rows : [], p.ticket.clientId);
      linkNote = picked.note;
      link = ticketEmailLink({
        callerOrigin: p.callerOrigin,
        tenantPrimaryDomain: picked.domain,
        clientId: p.ticket.clientId,
        ticketId: p.ticket.id,
      });
    } catch (e) {
      this.logger.error(`[tickets] remarks email link for ${p.ticket.id} failed: ${e}`);
      return notSent("the programme's web address could not be resolved (database error)");
    }
    // sendEmail silently no-ops when SMTP is unconfigured — never report that as sent.
    if (!this.msg91.isEmailConfigured()) return notSent('email (SMTP) is not configured on this environment');
    if (!link) return notSent('the ticket link could not be built');

    const html = [
      ...(toInbox
        ? [
            `<p>Hello,</p>`,
            `<p>${escapeHtml(p.by)} from Gifsy support has asked <strong>${escapeHtml(p.targetName)}</strong> (client admin) for remarks on support ticket <strong>${escapeHtml(p.ticket.ticketNumber)}</strong> — "${escapeHtml(p.ticket.subject)}". This was sent to your programme's ticket remarks inbox; ${escapeHtml(p.targetName)} can reply in the admin portal.</p>`,
          ]
        : [
            `<p>Hi ${escapeHtml(p.targetName)},</p>`,
            `<p>${escapeHtml(p.by)} from Gifsy support needs your remarks on support ticket <strong>${escapeHtml(p.ticket.ticketNumber)}</strong> — "${escapeHtml(p.ticket.subject)}".</p>`,
          ]),
      `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#333">${escapeHtml(p.note).replace(/\n/g, '<br>')}</blockquote>`,
      `<p><a href="${escapeHtml(link)}">Open the ticket and reply</a></p>`,
      `<p style="color:#888;font-size:12px">Your reply is visible to Gifsy support and your admin team only — never to the outlet or sales team.</p>`,
    ].join('\n');

    try {
      await this.msg91.sendEmail({ to: [to], subject: `Remarks needed: ticket ${p.ticket.ticketNumber}`, html });
    } catch (e) {
      this.logger.error(`[tickets] remarks email for ${p.ticket.id} failed: ${(e as Error)?.message ?? e}`);
      return notSent('the mail relay refused or timed out');
    }
    await this.recordEmailOutcome(
      p.ticket.id,
      p.actorId,
      `${toInbox ? `Email sent to ${to} (client's ticket remarks inbox) — asked: ${p.targetName}` : `Email sent to ${p.targetName} (${to})`} with link ${link}.${linkNote ? ` Note: ${linkNote}.` : ''}`,
    );
    return { sent: true };
  }

  /**
   * POST :id/cancel-client-remarks — Gifsy withdraws a pending remarks request and resumes the
   * ticket per resumeStatusAfterRemarks (the same rule as a client reply).
   * Shared note ("Remarks request to X cancelled — <reason>") + bell to the client admin + audit.
   * Guarded like every other transition (409 on a concurrent change).
   */
  async cancelClientRemarks(user: JwtPayload, id: string, dto: CancelClientRemarksDto) {
    this.assertGifsyOperator(user);
    const ticket = await this.loadTenantTicket(user, id);
    const pending = ticket.status === 'WAITING_ON_CLIENT' ? (readMeta(ticket.metadata).clientRemarks ?? null) : null;
    if (!pending) throw new BadRequestException('This ticket is not waiting on a client remarks request');
    const extra = dto.reason?.trim();
    const backTo = resumeStatusAfterRemarks(pending.fromStatus);

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.ticket.updateMany({
        where: this.unchangedSince(user, ticket),
        data: { status: backTo, metadata: withoutRemarks(ticket.metadata), updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException(TicketsService.CONFLICT);
      await this.recordRemarksCancelled(tx, ticket, user.sub);
      if (extra) {
        await tx.ticketMessage.create({ data: this.note(id, user.sub, `Remarks request withdrawn: ${extra}`, 'GIFSY_ONLY') });
      }
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'CANCEL_CLIENT_REMARKS', requestedFromId: pending.requestedFromId, status: backTo, reason: extra ?? null },
        },
      });
    });
    await this.bellCancelled(ticket, pending);
    return { message: `Request to ${pending.requestedFromName} cancelled`, status: backTo };
  }

  /**
   * POST :id/client-remarks — the tenant's CLIENT_ADMIN answers a remarks request. Stored as a
   * SHARED_WITH_CLIENT internal message (Gifsy + the tenant's desk; outlet/sales never). The
   * ticket returns to its pre-remarks state — ESCALATED if it was escalated, else IN_PROGRESS —
   * and the marker clears; the requesting Gifsy user (and a Gifsy assignee) get a bell. Any
   * CLIENT_ADMIN of the ticket's own tenant may answer; never another tenant's.
   */
  async replyClientRemarks(user: JwtPayload, id: string, dto: ClientRemarksReplyDto) {
    // Exactly CLIENT_ADMIN — GIFSY_ADMIN passes every @Roles check, so re-check the role here.
    if (user.role !== 'CLIENT_ADMIN') throw new ForbiddenException('Only the client admin can reply with remarks');
    const ticket = await this.loadTenantTicket(user, id);
    if (ticket.status !== 'WAITING_ON_CLIENT') {
      throw new BadRequestException('This ticket is not waiting for your remarks');
    }
    const message = dto.message.trim();
    if (!message) throw new BadRequestException('Remarks cannot be empty');
    const request = readMeta(ticket.metadata).clientRemarks ?? null;
    const backTo = resumeStatusAfterRemarks(request?.fromStatus);

    await this.prisma.$transaction(async (tx) => {
      // Conditional transition pinned to the request we read: a status change or a re-request
      // meanwhile → 409, never a resurrected ticket or a silently wiped newer request.
      const moved = await tx.ticket.updateMany({
        where: {
          id,
          clientId: user.clientId,
          status: 'WAITING_ON_CLIENT',
          ...(request?.requestedAt
            ? { metadata: { path: ['clientRemarks', 'requestedAt'], equals: request.requestedAt } }
            : {}),
        },
        data: { status: backTo, metadata: withoutRemarks(ticket.metadata), updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException('The ticket changed while you were replying — please reload');
      await tx.ticketMessage.create({ data: { ...this.note(id, user.sub, message, 'SHARED_WITH_CLIENT'), isClientRemarks: true } });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'CLIENT_REMARKS_REPLY', requestedById: request?.requestedById ?? null, status: backTo },
        },
      });
    });

    const by = user.name || 'The client admin';
    const recipients = new Set<string>();
    if (request?.requestedById) recipients.add(request.requestedById);
    if (ticket.assignedToId) {
      const a = await this.prisma.user.findFirst({ where: { id: ticket.assignedToId }, select: { id: true, role: true } });
      if (a && (a.role === 'GIFSY_ADMIN' || a.role === 'GIFSY_STAFF')) recipients.add(a.id);
    }
    recipients.delete(user.sub);
    for (const userId of recipients) {
      await this.notifications.writeInApp({
        userId,
        subject: `Client remarks received on ticket ${ticket.ticketNumber}`,
        body: `${by} replied: ${message.length > 200 ? `${message.slice(0, 200)}…` : message}`,
        url: ticketPath(id),
        variables: { event: 'TICKET_CLIENT_REMARKS_RECEIVED', ticketId: id },
      });
    }
    return { message: 'Remarks sent to Gifsy support', status: backTo };
  }

  /**
   * Support-admin status transition: Resolve / Close / Reopen. Optimistic guard (status +
   * updatedAt) so a concurrent change → 409. While a ticket is WAITING_ON_CLIENT:
   *  - the tenant's desk (CLIENT_ADMIN / MIS_USER) may NOT resolve / close / reopen it — Gifsy is
   *    waiting on their remarks; they reply first (one clear path, no half-cancelled state);
   *  - Gifsy may, and the pending request is cancelled explicitly (shared note + bell).
   */
  async setStatus(user: JwtPayload, id: string, dto: SetTicketStatusDto) {
    if (!this.isSupportAdmin(user)) throw new ForbiddenException('Forbidden');

    const ticket = await this.loadTenantTicket(user, id);
    const status = dto.status;
    if (!SETTABLE_TICKET_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid status '${status}'`);
    }
    if (ticket.status === 'WAITING_ON_CLIENT' && this.reader(user) === 'CLIENT') {
      throw new ConflictException('Gifsy support is waiting for your remarks on this ticket — send your remarks first.');
    }
    const cancelReason = `the ticket was ${STATUS_ACTION_LABEL[status] ?? `set to ${status}`}`;
    const hasMarker = readMeta(ticket.metadata).clientRemarks != null;

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const nowTs = new Date();
      // Stamp resolution timestamps so the Operations dashboard's MTTR + SLA are real.
      const stamp =
        status === 'RESOLVED'
          ? { resolvedAt: nowTs, closedAt: null }
          : status === 'CLOSED'
            ? { closedAt: nowTs }
            : { resolvedAt: null, closedAt: null };
      const moved = await tx.ticket.updateMany({
        where: this.unchangedSince(user, ticket),
        data: { status, updatedAt: nowTs, ...stamp, ...(hasMarker ? { metadata: withoutRemarks(ticket.metadata) } : {}) },
      });
      if (moved.count !== 1) throw new ConflictException(TicketsService.CONFLICT);
      const c = await this.recordRemarksCancelled(tx, ticket, user.sub, cancelReason);
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: `Ticket ${STATUS_ACTION_LABEL[status] ?? `set to ${status}`} by support.`,
          senderId: user.sub,
          isInternal: false,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { status, cancelledRemarksFrom: c?.requestedFromId ?? null },
        },
      });
      return c;
    });

    await this.bellCancelled(ticket, cancelled, cancelReason);
    return { message: 'Ticket status updated', cancelledRemarksFrom: cancelled ? cancelled.requestedFromName : null };
  }

  /**
   * Post a message. Internal-note visibility: a Gifsy operator's note defaults to GIFSY_ONLY (they
   * may choose SHARED_WITH_CLIENT); a client-desk note is always SHARED_WITH_CLIENT.
   *
   * Concurrency: the message and the ticket touch commit together, guarded on the status the
   * decision was based on — a reply racing a close/escalate never revives a CLOSED ticket and
   * never overwrites ESCALATED with IN_PROGRESS (409 "reload"; nothing is written). A status
   * transition (OPEN → IN_PROGRESS, RESOLVED → IN_PROGRESS) is additionally pinned to updatedAt.
   */
  async addMessage(user: JwtPayload, id: string, dto: AddMessageDto) {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    await this.assertAccess(user, ticket);
    const t = ticket as TicketRow;
    if (t.status === 'CLOSED') throw new BadRequestException('Cannot add message to a closed ticket');
    const isInternal = dto.isInternal ?? false;
    if (isInternal && !this.isSupportAdmin(user)) {
      throw new ForbiddenException('Forbidden - Internal notes are admin only');
    }
    const reader = this.reader(user);
    const internalVisibility: TicketNoteVisibility | null = !isInternal
      ? null
      : reader === 'GIFSY'
        ? (dto.visibility ?? 'GIFSY_ONLY')
        : 'SHARED_WITH_CLIENT';

    const message = await this.prisma.$transaction(async (tx) => {
      const nowTs = new Date();
      const isAdmin = reader !== 'FIELD';
      const patch: {
        status?: 'IN_PROGRESS';
        firstResponseAt?: Date;
        resolvedAt?: null;
      } = {};
      // First-response = the first non-internal reply from support (real first-response TAT).
      if (isAdmin && !isInternal && t.firstResponseAt == null) patch.firstResponseAt = nowTs;
      // A support admin replying to an OPEN ticket moves it to IN_PROGRESS.
      if (isAdmin && t.status === 'OPEN') patch.status = 'IN_PROGRESS';
      // The raiser replying to a RESOLVED ticket reopens it (clear resolvedAt so MTTR is real).
      if (!isAdmin && t.status === 'RESOLVED') {
        patch.status = 'IN_PROGRESS';
        patch.resolvedAt = null;
      }
      const guard: Prisma.TicketWhereInput = patch.status
        ? this.unchangedSince(user, t)
        : { id, clientId: user.clientId, status: t.status };
      const touched = await tx.ticket.updateMany({ where: guard, data: { ...patch, updatedAt: nowTs } });
      if (touched.count !== 1) {
        throw new ConflictException('The ticket changed meanwhile (it may have been closed or escalated) — reload and try again');
      }
      return tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: dto.message,
          attachments: dto.attachments ?? [],
          senderId: user.sub,
          isInternal,
          ...(internalVisibility ? { internalVisibility } : {}),
        },
      });
    });

    return { message };
  }
}
