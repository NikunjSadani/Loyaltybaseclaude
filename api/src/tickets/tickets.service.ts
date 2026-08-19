import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketPriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  AddMessageDto,
  CreateTicketDto,
  EscalateTicketDto,
  ListTicketsQueryDto,
  SetTicketStatusDto,
  SETTABLE_TICKET_STATUSES,
} from './dto/tickets.dto';

/** Human-readable labels for the system message posted on a status change. */
const STATUS_ACTION_LABEL: Record<string, string> = {
  RESOLVED: 'marked Resolved',
  CLOSED: 'Closed',
  IN_PROGRESS: 'Reopened',
  OPEN: 'Reopened',
};

/**
 * Support tickets — ported from platform/src/app/api/tickets/* (S4 pilot).
 * Tenant-scoped by clientId (from the session-bound JWT). Admin roles
 * (GIFSY_ADMIN / CLIENT_ADMIN / MIS_USER) see + manage ALL tickets in their
 * tenant (admin/tickets = "all support requests from outlets and sales team");
 * field roles (sales chain, partners) see/act on only the tickets they created.
 * Business logic lives here; the controller is a thin HTTP adapter.
 */
@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async list(user: JwtPayload, q: ListTicketsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.TicketWhereInput = { clientId: user.clientId };
    const isSupportAdmin = this.isSupportAdmin(user);
    // Field roles see only their own tickets; support admins see all tenant tickets.
    if (!isSupportAdmin) where.createdById = user.sub;
    if (q.status) where.status = q.status;
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
          createdBy: { select: { id: true, name: true, phone: true } },
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { messages: messagesCount } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { tickets, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async create(user: JwtPayload, dto: CreateTicketDto) {
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
    // Security: internal notes (isInternal=true) — support's private escalation notes
    // and admin-only notes — must NEVER reach a non-support reader (the ticket creator).
    // Filter them out at the DB layer for non-support readers; support admins see all.
    const messages: Prisma.Ticket$messagesArgs = {
      include: { sender: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    };
    if (!this.isSupportAdmin(user)) messages.where = { isInternal: false };

    const ticket = await this.loadAccessible(user, id, {
      createdBy: { select: { id: true, name: true, phone: true } },
      assignedTo: { select: { id: true, name: true } },
      messages,
    });
    return { ticket };
  }

  async escalate(user: JwtPayload, id: string, dto: EscalateTicketDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked here.
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    // GLm-2: verify the assignee exists AND belongs to the caller's tenant before
    // assigning — prevents cross-tenant escalation via a foreign user ID.
    const assignee = await this.prisma.user.findFirst({
      where: { id: dto.escalateTo, clientId: user.clientId },
      select: { id: true },
    });
    if (!assignee) {
      throw new BadRequestException(
        `Assignee user '${dto.escalateTo}' not found in this tenant`,
      );
    }

    const priority: TicketPriority = dto.priority ?? 'HIGH';

    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id },
        data: { status: 'ESCALATED', priority, assignedToId: dto.escalateTo, updatedAt: new Date() },
      });
      await tx.ticketMessage.create({
        data: { ticketId: id, message: `Ticket escalated. Reason: ${dto.reason}`, senderId: user.sub, isInternal: true },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: user.sub,
          metadata: { escalateTo: dto.escalateTo, reason: dto.reason, priority },
        },
      });
    });

    return { message: 'Ticket escalated successfully' };
  }

  /**
   * Support-admin status transition: Resolve / Close / Reopen. Re-checks
   * isSupportAdmin (defense in depth; the controller @Roles-gates too) and
   * tenant scope, then atomically updates the ticket, posts a NON-internal
   * system message so the raiser SEES the outcome, and writes an audit log.
   */
  async setStatus(user: JwtPayload, id: string, dto: SetTicketStatusDto) {
    if (!this.isSupportAdmin(user)) throw new ForbiddenException('Forbidden');

    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const status = dto.status;
    if (!SETTABLE_TICKET_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid status '${status}'`);
    }

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
        data: { status, updatedAt: nowTs, ...stamp },
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
