// Unit tests for TicketsService — the S4 pilot template.
// Covers tenant/access scoping + the business rules ported from the Next routes.
// Run: npx jest src/tickets/tickets.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  ticket: { update: jest.fn() },
  ticketMessage: { create: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  ticket: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  user: { findFirst: jest.fn() },
  ticketMessage: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'cadmin1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };

describe('TicketsService', () => {
  let service: TicketsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TicketsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(TicketsService);
  });

  describe('list', () => {
    it('scopes non-admins to their own tickets', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(partner, {});
      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', createdById: 'user1' });
    });

    it('does NOT add a createdById filter for GIFSY admins', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(gifsy, { status: 'OPEN' as never });
      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', status: 'OPEN' });
    });

    // Regression (P0.6): a tenant admin must see ALL tenant tickets, not only their own.
    // The admin/tickets page is "all support requests from outlets and sales team".
    it('does NOT add a createdById filter for CLIENT_ADMIN (sees all tenant tickets)', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(clientAdmin, {});
      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo' });
    });
  });

  describe('getOne', () => {
    it('throws NotFound when the ticket is outside the tenant', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.getOne(partner, 't1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Forbidden when a non-admin opens someone else’s ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'someoneElse' });
      await expect(service.getOne(partner, 't1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the ticket for its owner', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1' });
      await expect(service.getOne(partner, 't1')).resolves.toEqual({ ticket: { id: 't1', createdById: 'user1' } });
    });

    // Regression (P0.6): a tenant admin can open a ticket someone else created.
    it('returns a ticket created by another user for a CLIENT_ADMIN', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'someoneElse' });
      await expect(service.getOne(clientAdmin, 't1')).resolves.toEqual({ ticket: { id: 't1', createdById: 'someoneElse' } });
    });
  });

  describe('addMessage', () => {
    it('rejects messages on a CLOSED ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1', status: 'CLOSED' });
      await expect(service.addMessage(partner, 't1', { message: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects internal notes from non-admins', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1', status: 'OPEN' });
      await expect(
        service.addMessage(partner, 't1', { message: 'secret', isInternal: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('creates a message and promotes an OPEN ticket to IN_PROGRESS when an admin replies', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1', status: 'OPEN' });
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm1' });
      const res = await service.addMessage(gifsy, 't1', { message: 'on it' });
      expect(res).toEqual({ message: { id: 'm1' } });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'IN_PROGRESS', updatedAt: expect.any(Date) },
      });
    });
  });

  describe('escalate', () => {
    it('throws NotFound for a missing ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.escalate(gifsy, 't1', { escalateTo: 'u2', reason: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('GLm-2: throws BadRequest when the assignee is not in the caller tenant', async () => {
      // Ticket exists in the caller's tenant but the proposed assignee does not.
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue(null); // foreign / unknown user
      await expect(
        service.escalate(gifsy, 't1', { escalateTo: 'foreign-user', reason: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('GLm-2: assignee lookup is scoped to the caller clientId', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u2' }); // in-tenant assignee
      await service.escalate(gifsy, 't1', { escalateTo: 'u2', reason: 'urgent' });
      const where = mockPrisma.user.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: 'u2', clientId: 'deoleo' });
    });

    it('updates status/priority, posts an internal note, and writes an audit log', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u2' }); // valid in-tenant assignee
      await service.escalate(gifsy, 't1', { escalateTo: 'u2', reason: 'urgent' });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'ESCALATED', priority: 'HIGH', assignedToId: 'u2', updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create).toHaveBeenCalled();
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });
  });
});
