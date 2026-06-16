import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketPriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AddMessageDto, CreateTicketDto, EscalateTicketDto, ListTicketsQueryDto } from './dto/tickets.dto';

/**
 * Support tickets — ported from platform/src/app/api/tickets/* (S4 pilot).
 * Tenant-scoped by clientId (from the session-bound JWT); non-GIFSY callers
 * see/act on only their own tickets. Business logic lives here; the controller
 * is a thin HTTP adapter.
 */
@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  private isGifsy(user: JwtPayload): boolean {
    return user.role === 'GIFSY_ADMIN';
  }

  async list(user: JwtPayload, q: ListTicketsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.TicketWhereInput = { clientId: user.clientId };
    // Non-admins are scoped to the tickets they created.
    if (!this.isGifsy(user)) where.createdById = user.sub;
    if (q.status) where.status = q.status;
    if (q.category) where.category = q.category;

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true, phone: true } },
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
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
    if (!this.isGifsy(user) && ticket.createdById !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }
    return ticket;
  }

  async getOne(user: JwtPayload, id: string) {
    const ticket = await this.loadAccessible(user, id, {
      createdBy: { select: { id: true, name: true, phone: true } },
      assignedTo: { select: { id: true, name: true } },
      messages: {
        include: { sender: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: 'asc' },
      },
    });
    return { ticket };
  }

  async escalate(user: JwtPayload, id: string, dto: EscalateTicketDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked here.
    const ticket = await this.prisma.ticket.findFirst({ where: { id, clientId: user.clientId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
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

  async addMessage(user: JwtPayload, id: string, dto: AddMessageDto) {
    const ticket = await this.loadAccessible(user, id);
    if (ticket.status === 'CLOSED') throw new BadRequestException('Cannot add message to a closed ticket');
    const isInternal = dto.isInternal ?? false;
    if (isInternal && !this.isGifsy(user)) {
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
      // Admin replying to an OPEN ticket moves it to IN_PROGRESS.
      if (this.isGifsy(user) && ticket.status === 'OPEN') {
        await tx.ticket.update({ where: { id }, data: { status: 'IN_PROGRESS', updatedAt: new Date() } });
      }
      return msg;
    });

    return { message };
  }
}
