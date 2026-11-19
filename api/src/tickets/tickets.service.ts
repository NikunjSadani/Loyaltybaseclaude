import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator } from '../common/tenant-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import {
  AddMessageDto,
  AssignTicketDto,
  ClientRemarksReplyDto,
  CreateTicketDto,
  EscalateTicketDto,
  ListTicketsQueryDto,
  RequestClientRemarksDto,
  SetTicketStatusDto,
  SETTABLE_TICKET_STATUSES,
} from './dto/tickets.dto';
import { escapeHtml, ticketEmailLink, ticketPath } from './ticket-link';
import {
  OUTLET_REFERENCE_TYPE,
  PARTNER_ROLES,
  TICKET_CREATOR_SELECT,
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

/**
 * The pending "remarks requested from a client admin" marker, stored at
 * Ticket.metadata.clientRemarks while status = WAITING_ON_CLIENT. Support-admin-only data:
 * stripped from every outlet/sales read (see sanitizeForReader).
 */
export interface ClientRemarksRequest {
  requestedFromId: string;
  requestedFromName: string;
  requestedById: string;
  requestedByName: string;
  note: string;
  requestedAt: string;
}

/** One person a ticket may be assigned / escalated / sent to. */
export interface TicketAssignee {
  id: string;
  name: string;
  role: string;
  kind: 'GIFSY' | 'CLIENT_ADMIN';
}

type TicketMeta = Record<string, unknown> & { clientRemarks?: ClientRemarksRequest | null };

function readMeta(metadata: unknown): TicketMeta {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as TicketMeta) } : {};
}

/** The metadata with the pending client-remarks marker removed (other keys preserved). */
function withoutRemarks(metadata: unknown): Prisma.InputJsonValue {
  const m = readMeta(metadata);
  delete m.clientRemarks;
  return m as Prisma.InputJsonValue;
}

/**
 * Support tickets — ported from platform/src/app/api/tickets/* (S4 pilot).
 * Tenant-scoped by clientId (from the session-bound JWT). Admin roles
 * (GIFSY_ADMIN / CLIENT_ADMIN / MIS_USER) see + manage ALL tickets in their
 * tenant (admin/tickets = "all support requests from outlets and sales team");
 * field roles (sales chain, partners) see/act on only the tickets they created.
 * Business logic lives here; the controller is a thin HTTP adapter.
 *
 * Assign / escalate / client-remarks (2026-11-19, SUPPORT-TICKETS.md): Gifsy operators assign a
 * ticket to a Gifsy operator or one of the ticket tenant's CLIENT_ADMINs, escalate to a Gifsy
 * operator, or ask a CLIENT_ADMIN for remarks (→ WAITING_ON_CLIENT + bell + email). The client
 * admin's reply is an INTERNAL message. Internal messages, the remarks marker (metadata) and the
 * WAITING_ON_CLIENT status never reach an outlet/sales reader.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
  ) {}

  /**
   * Tenant-support admins: see + manage every ticket in their tenant. GIFSY is
   * the platform operator; CLIENT_ADMIN/MIS_USER are the tenant's support desk.
   * Field roles (SALES_*, SSS/WHOLESALER/SUB_STOCKIST) are NOT admins — they are
   * scoped to their own tickets.
   */
  private isSupportAdmin(user: JwtPayload): boolean {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    return user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF' || user.role === 'CLIENT_ADMIN' || user.role === 'MIS_USER';
  }

  /**
   * Security: what a NON-support reader (the outlet / sales raiser) may see of a ticket.
   * Strips `metadata` (holds the client-remarks request note) and masks the support-internal
   * WAITING_ON_CLIENT state as IN_PROGRESS. Support admins get the row unchanged.
   */
  private sanitizeForReader<T extends Record<string, unknown>>(user: JwtPayload, ticket: T): T {
    if (this.isSupportAdmin(user)) return ticket;
    const out: Record<string, unknown> = { ...ticket };
    delete out.metadata;
    if (out.status === 'WAITING_ON_CLIENT') out.status = 'IN_PROGRESS';
    return out as T;
  }

  /**
   * Support-admin reads: attach `raisedBy` (outlet owner vs sales person + designation) and
   * `outlet` (id / outletCode / name, or null = "—") — see ticket-submitter.ts for the rules.
   * Referenced outlets are batch-loaded, tenant-pinned (one query per page, no N+1).
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
      return {
        ...r,
        raisedBy: describeRaisedBy(creator),
        outlet: resolveTicketOutlet(
          { referenceType: r.referenceType as string | null, referenceId: r.referenceId as string | null },
          creator,
          byId,
        ),
      };
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
    if (!ok) throw new BadRequestException('That outlet is not one you can raise a ticket for');
  }

  async list(user: JwtPayload, q: ListTicketsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.TicketWhereInput = { clientId: user.clientId };
    const isSupportAdmin = this.isSupportAdmin(user);
    // Field roles see only their own tickets; support admins see all tenant tickets.
    if (!isSupportAdmin) where.createdById = user.sub;
    if (q.status) {
      if (isSupportAdmin) {
        where.status = q.status;
      } else if (q.status === 'IN_PROGRESS') {
        // A field reader sees WAITING_ON_CLIENT as IN_PROGRESS, so its filter must match both.
        where.status = { in: ['IN_PROGRESS', 'WAITING_ON_CLIENT'] };
      } else if (q.status === 'WAITING_ON_CLIENT') {
        // ...and the support-internal state itself never matches for them (no existence leak).
        where.status = { in: [] };
      } else {
        where.status = q.status;
      }
    }
    if (q.category) where.category = q.category;

    // Non-support readers never see internal notes (see getOne), so the message
    // count must exclude them too — otherwise the badge over-counts messages the
    // reader can't open. Support admins count all messages.
    const messagesCount: Prisma.TicketCountOutputTypeSelect['messages'] = isSupportAdmin
      ? true
      : { where: { isInternal: false } };

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: {
          createdBy: { select: isSupportAdmin ? TICKET_CREATOR_SELECT : { id: true, name: true, phone: true } },
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { messages: messagesCount } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    const result: {
      tickets: unknown[];
      pagination: { page: number; limit: number; total: number; pages: number };
      awaitingClient?: { total: number; mine: number };
    } = {
      tickets: isSupportAdmin
        ? await this.withSubmitter(user.clientId, (tickets ?? []) as unknown as Record<string, unknown>[])
        : (tickets ?? []).map((t) => this.sanitizeForReader(user, t as unknown as Record<string, unknown>)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };

    // Support admins get the tenant-wide "awaiting client" count (independent of paging /
    // filters) + how many of those wait on THIS caller (a CLIENT_ADMIN's "awaiting your remarks").
    if (isSupportAdmin) {
      const base: Prisma.TicketWhereInput = { clientId: user.clientId, status: 'WAITING_ON_CLIENT' };
      const [awaitTotal, awaitMine] = await Promise.all([
        this.prisma.ticket.count({ where: base }),
        user.role === 'CLIENT_ADMIN'
          ? this.prisma.ticket.count({
              where: { ...base, metadata: { path: ['clientRemarks', 'requestedFromId'], equals: user.sub } },
            })
          : Promise.resolve(0),
      ]);
      result.awaitingClient = { total: awaitTotal ?? 0, mine: awaitMine ?? 0 };
    }

    return result;
  }

  async create(user: JwtPayload, dto: CreateTicketDto) {
    if (dto.outletId) await this.assertOutletForRaiser(user, dto.outletId);
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
    const ticket = await this.prisma.ticket.create({
      data: {
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
      },
      include: { messages: true },
    });
    return { ticket };
  }

  /** Loads a ticket within the caller's tenant + access scope, or throws. */
  private async loadAccessible(user: JwtPayload, id: string, include?: Prisma.TicketInclude) {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId }, include });
    if (!ticket) throw new NotFoundException('Ticket not found');
    // Support admins can open any ticket in their tenant; field roles only their own.
    if (!this.isSupportAdmin(user) && ticket.createdById !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }
    return ticket;
  }

  async getOne(user: JwtPayload, id: string) {
    // Security: internal notes (isInternal=true) — support's private escalation notes,
    // admin-only notes AND the client admin's remarks — must NEVER reach a non-support
    // reader (the ticket creator). Filter them out at the DB layer for non-support readers;
    // support admins see all.
    const messages: Prisma.Ticket$messagesArgs = {
      include: { sender: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    };
    if (!this.isSupportAdmin(user)) messages.where = { isInternal: false };

    const isSupportAdmin = this.isSupportAdmin(user);
    const ticket = await this.loadAccessible(user, id, {
      createdBy: { select: isSupportAdmin ? TICKET_CREATOR_SELECT : { id: true, name: true, phone: true } },
      assignedTo: { select: { id: true, name: true } },
      messages,
    });
    if (isSupportAdmin) {
      const [enriched] = await this.withSubmitter(user.clientId, [ticket as unknown as Record<string, unknown>]);
      return { ticket: enriched };
    }
    return { ticket: this.sanitizeForReader(user, ticket as unknown as Record<string, unknown>) };
  }

  // ─── Assign / escalate / client remarks ──────────────────────────────────────

  /** Gifsy-operator-only guard (defense in depth; the controller @Roles-gates too). */
  private assertGifsyOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) throw new ForbiddenException('Only Gifsy support can do this');
  }

  /** A ticket in the caller's (assumed) tenant, or 404. */
  private async loadTenantTicket(user: JwtPayload, id: string) {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /**
   * Everyone a ticket of tenant `clientId` may be assigned to:
   *  - active Gifsy OWNERs (GIFSY_ADMIN at the gifsy home tenant — may operate on any tenant);
   *  - active GIFSY_STAFF holding a GifsyStaffTenantGrant for THIS tenant (deny-by-default:
   *    an ungranted staff could not even open the ticket);
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
          // Must be able to open the ticket they are given (fail-closed like PermissionGuard).
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
          ? 'an active client admin of this ticket\'s programme'
          : kind === 'GIFSY'
            ? 'an active Gifsy support user who can work on this programme'
            : 'Gifsy support or a client admin of this ticket\'s programme';
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

  /**
   * POST :id/assign — assign (or unassign with `assigneeId: null`). Gifsy operators only.
   * Writes an internal thread note ("Assigned to X by Y") + an audit row; bells the new
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
    const note = assignee ? `Assigned to ${assignee.name} by ${by}.` : `Unassigned by ${by}.`;

    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id }, data: { assignedToId: assignee?.id ?? null, updatedAt: new Date() } });
      await tx.ticketMessage.create({ data: { ticketId: id, message: note, senderId: user.sub, isInternal: true } });
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
    return { message: note, assignedTo: assignee };
  }

  /**
   * POST :id/escalate — internal escalation to a Gifsy operator the caller picks: priority
   * bump (default HIGH) + ESCALATED + the target becomes the assignee. No longer requires a
   * prior assignment. Client admins are NOT escalation targets — involving the client goes
   * through requestClientRemarks (its own state, bell + email). Clears a pending remarks
   * request (the ticket is no longer waiting on the client).
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

    await this.prisma.$transaction(async (tx) => {
      // Optimistic guard: refuse if the ticket changed since it was read (e.g. closed meanwhile)
      // rather than resurrecting a CLOSED ticket as ESCALATED.
      const moved = await tx.ticket.updateMany({
        where: { id, clientId: user.clientId, status: ticket.status, updatedAt: ticket.updatedAt },
        data: {
          status: 'ESCALATED',
          priority,
          assignedToId: target.id,
          metadata: withoutRemarks(ticket.metadata),
          updatedAt: new Date(),
        },
      });
      if (moved.count !== 1) throw new ConflictException('The ticket changed meanwhile — reload and try again');
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: `Ticket escalated to ${target.name} by ${by} (priority ${priority}). Reason: ${dto.reason}`,
          senderId: user.sub,
          isInternal: true,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'ESCALATE', escalateTo: target.id, reason: dto.reason, priority },
        },
      });
    });

    if (target.id !== user.sub) {
      await this.notifications.writeInApp({
        userId: target.id,
        subject: `Ticket ${ticket.ticketNumber} escalated to you`,
        body: `${by} escalated "${ticket.subject}" (priority ${priority}). Reason: ${dto.reason}`,
        url: ticketPath(id),
        variables: { event: 'TICKET_ESCALATED', ticketId: id },
      });
    }
    return { message: 'Ticket escalated successfully', escalatedTo: target };
  }

  /**
   * POST :id/request-client-remarks — a Gifsy operator asks one of the ticket tenant's
   * CLIENT_ADMINs for remarks. → status WAITING_ON_CLIENT, marker in metadata.clientRemarks,
   * internal thread note, audit; then (after commit) bell + email to that client admin. The
   * email is the ONLY email this module sends, and only here. A missing address / failed send
   * never undoes the request: it is reported back (emailSent=false + reason) AND recorded as an
   * internal thread note so it is never silent.
   */
  async requestClientRemarks(user: JwtPayload, id: string, dto: RequestClientRemarksDto, callerOrigin: string) {
    this.assertGifsyOperator(user);
    const ticket = await this.loadTenantTicket(user, id);
    if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') {
      throw new BadRequestException('Reopen the ticket before asking the client for remarks');
    }
    const note = dto.note.trim();
    if (!note) throw new BadRequestException('Describe what you need from the client admin');

    const target = await this.resolveAssignee(ticket.clientId, dto.clientAdminId, 'CLIENT_ADMIN');
    const by = await this.actorName(user);
    const request: ClientRemarksRequest = {
      requestedFromId: target.id,
      requestedFromName: target.name,
      requestedById: user.sub,
      requestedByName: by,
      note,
      requestedAt: new Date().toISOString(),
    };
    const metadata = { ...readMeta(ticket.metadata), clientRemarks: request } as unknown as Prisma.InputJsonValue;

    await this.prisma.$transaction(async (tx) => {
      // Optimistic guard (same as escalate): never turn a ticket closed/changed meanwhile into
      // WAITING_ON_CLIENT, and never clobber a concurrent remarks request's marker.
      const moved = await tx.ticket.updateMany({
        where: { id, clientId: user.clientId, status: ticket.status, updatedAt: ticket.updatedAt },
        data: { status: 'WAITING_ON_CLIENT', metadata, updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException('The ticket changed meanwhile — reload and try again');
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: `Remarks requested from ${target.name} (client admin) by ${by}: ${note}`,
          senderId: user.sub,
          isInternal: true,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'REQUEST_CLIENT_REMARKS', requestedFromId: target.id, fromStatus: ticket.status, note },
        },
      });
    });

    // Bell (in-app) — best-effort by contract (writeInApp never throws).
    await this.notifications.writeInApp({
      userId: target.id,
      subject: `Your remarks are needed on ticket ${ticket.ticketNumber}`,
      body: `${by} (Gifsy support) asked: ${note}`,
      url: ticketPath(id),
      variables: { event: 'TICKET_CLIENT_REMARKS_REQUESTED', ticketId: id },
    });

    // Email — via the same MSG91 SMTP relay as scheduled reports / the daily digest.
    const email = await this.emailRemarksRequest({ ticket, targetId: target.id, targetName: target.name, by, note, callerOrigin });
    if (!email.sent) {
      await this.prisma.ticketMessage
        .create({
          data: {
            ticketId: id,
            message: `Email to ${target.name} was NOT sent: ${email.reason}. They were notified in-app only.`,
            senderId: user.sub,
            isInternal: true,
          },
        })
        .catch((e) => this.logger.warn(`[tickets] could not record email failure on ${id}: ${e}`));
    }

    return {
      message: `Remarks requested from ${target.name}`,
      requestedFrom: target,
      emailSent: email.sent,
      ...(email.sent ? {} : { emailError: email.reason }),
    };
  }

  private async emailRemarksRequest(p: {
    ticket: { id: string; clientId: string; ticketNumber: string; subject: string };
    targetId: string;
    targetName: string;
    by: string;
    note: string;
    callerOrigin: string;
  }): Promise<{ sent: true } | { sent: false; reason: string }> {
    try {
      const u = await this.prisma.user.findFirst({ where: { id: p.targetId }, select: { email: true } });
      const to = (u?.email ?? '').trim();
      if (!to) return { sent: false, reason: 'the client admin has no email address on file' };
      // sendEmail silently no-ops when SMTP is unconfigured — never report that as "sent".
      if (!this.msg91.isEmailConfigured()) return { sent: false, reason: 'email (SMTP) is not configured on this environment' };
      const domain = await this.prisma.clientDomain.findFirst({
        where: { clientId: p.ticket.clientId },
        orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }],
        select: { domain: true },
      });
      const link = ticketEmailLink({
        callerOrigin: p.callerOrigin,
        tenantPrimaryDomain: domain?.domain ?? null,
        clientId: p.ticket.clientId,
        ticketId: p.ticket.id,
      });
      const html = [
        `<p>Hi ${escapeHtml(p.targetName)},</p>`,
        `<p>${escapeHtml(p.by)} from Gifsy support needs your remarks on support ticket <strong>${escapeHtml(p.ticket.ticketNumber)}</strong> — "${escapeHtml(p.ticket.subject)}".</p>`,
        `<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#333">${escapeHtml(p.note).replace(/\n/g, '<br>')}</blockquote>`,
        `<p><a href="${escapeHtml(link)}">Open the ticket and reply</a></p>`,
        `<p style="color:#888;font-size:12px">Your reply is visible to Gifsy support and your admin team only — never to the outlet or sales team.</p>`,
      ].join('\n');
      await this.msg91.sendEmail({ to: [to], subject: `Remarks needed: ticket ${p.ticket.ticketNumber}`, html });
      return { sent: true };
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      this.logger.error(`[tickets] remarks email for ${p.ticket.id} failed: ${reason}`);
      return { sent: false, reason: 'the email could not be sent (mail relay error)' };
    }
  }

  /**
   * POST :id/client-remarks — the tenant's CLIENT_ADMIN answers a remarks request. Stored as
   * an INTERNAL message (Gifsy + the tenant's admins see it; outlet/sales never). The ticket
   * returns to IN_PROGRESS and the marker clears; the requesting Gifsy user (and a Gifsy
   * assignee) get a bell. Any CLIENT_ADMIN of the ticket's own tenant may answer (cover for an
   * absent colleague); never another tenant's (the ticket lookup is pinned to the JWT clientId).
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

    await this.prisma.$transaction(async (tx) => {
      // Conditional transition: if Gifsy changed the status meanwhile, refuse instead of
      // silently resurrecting a closed/escalated ticket.
      const moved = await tx.ticket.updateMany({
        where: {
          id,
          clientId: user.clientId,
          status: 'WAITING_ON_CLIENT',
          // Pin to the request we read: a re-request (new marker) meanwhile → 409, not a silent wipe.
          ...(request?.requestedAt
            ? { metadata: { path: ['clientRemarks', 'requestedAt'], equals: request.requestedAt } }
            : {}),
        },
        data: { status: 'IN_PROGRESS', metadata: withoutRemarks(ticket.metadata), updatedAt: new Date() },
      });
      if (moved.count !== 1) throw new ConflictException('The ticket changed while you were replying — please reload');
      await tx.ticketMessage.create({ data: { ticketId: id, message, senderId: user.sub, isInternal: true } });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { action: 'CLIENT_REMARKS_REPLY', requestedById: request?.requestedById ?? null },
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
    return { message: 'Remarks sent to Gifsy support' };
  }

  /**
   * Support-admin status transition: Resolve / Close / Reopen. Re-checks
   * isSupportAdmin (defense in depth; the controller @Roles-gates too) and
   * tenant scope, then atomically updates the ticket, posts a NON-internal
   * system message so the raiser SEES the outcome, and writes an audit log.
   * Any status change also clears a pending client-remarks request.
   */
  async setStatus(user: JwtPayload, id: string, dto: SetTicketStatusDto) {
    if (!this.isSupportAdmin(user)) throw new ForbiddenException('Forbidden');

    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const status = dto.status;
    if (!SETTABLE_TICKET_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid status '${status}'`);
    }
    const clearsRemarks = (ticket.status as TicketStatus) === 'WAITING_ON_CLIENT' || readMeta(ticket.metadata).clientRemarks != null;

    await this.prisma.$transaction(async (tx) => {
      const nowTs = new Date();
      // Stamp resolution timestamps so the Operations dashboard's MTTR + SLA are real.
      // → RESOLVED records resolvedAt (clears any prior closedAt); → CLOSED records
      // closedAt; any move back to a non-terminal state (reopen) clears both so MTTR
      // reflects the eventual real resolution, not a superseded one.
      const stamp =
        status === 'RESOLVED'
          ? { resolvedAt: nowTs, closedAt: null }
          : status === 'CLOSED'
            ? { closedAt: nowTs }
            : { resolvedAt: null, closedAt: null };
      await tx.ticket.update({
        where: { id },
        data: { status, updatedAt: nowTs, ...stamp, ...(clearsRemarks ? { metadata: withoutRemarks(ticket.metadata) } : {}) },
      });
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
          metadata: { status },
        },
      });
    });

    return { message: 'Ticket status updated' };
  }

  async addMessage(user: JwtPayload, id: string, dto: AddMessageDto) {
    const ticket = await this.loadAccessible(user, id);
    if (ticket.status === 'CLOSED') throw new BadRequestException('Cannot add message to a closed ticket');
    const isInternal = dto.isInternal ?? false;
    if (isInternal && !this.isSupportAdmin(user)) {
      throw new ForbiddenException('Forbidden - Internal notes are admin only');
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: dto.message,
          attachments: dto.attachments ?? [],
          senderId: user.sub,
          isInternal,
        },
      });
      // Stamp first-response (first non-internal reply by support) + drive the status
      // transitions, in ONE update.
      const nowTs = new Date();
      const isAdmin = this.isSupportAdmin(user);
      const patch: {
        status?: 'IN_PROGRESS';
        updatedAt?: Date;
        firstResponseAt?: Date;
        resolvedAt?: null;
      } = {};
      // First-response = the first non-internal reply from support (real first-response TAT).
      if (isAdmin && !isInternal && ticket.firstResponseAt == null) {
        patch.firstResponseAt = nowTs;
      }
      // A support admin replying to an OPEN ticket moves it to IN_PROGRESS.
      if (isAdmin && ticket.status === 'OPEN') {
        patch.status = 'IN_PROGRESS';
      }
      // The raiser (a non-admin) replying to a RESOLVED ticket reopens it so the support
      // loop resumes — clear resolvedAt so MTTR counts the eventual real resolution.
      // (A CLOSED ticket is already rejected above.)
      if (!isAdmin && ticket.status === 'RESOLVED') {
        patch.status = 'IN_PROGRESS';
        patch.resolvedAt = null;
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = nowTs;
        await tx.ticket.update({ where: { id }, data: patch });
      }
      return msg;
    });

    return { message };
  }
}
