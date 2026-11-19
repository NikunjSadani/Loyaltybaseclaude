// Unit tests for TicketsService — the S4 pilot template.
// Covers tenant/access scoping + the business rules ported from the Next routes.
// Run: npx jest src/tickets/tickets.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';

const mockTx = {
  ticket: { update: jest.fn(), updateMany: jest.fn() },
  ticketMessage: { create: jest.fn() },
  auditLog: { create: jest.fn() },
};

/** A tiny in-memory user table so the assignable-set queries are exercised for real. */
interface FakeUser {
  id: string; name: string; role: string; clientId: string; status: string;
  deletedAt: Date | null; email?: string | null; grants?: string[];
}
let USERS: FakeUser[] = [];
function matchUser(u: FakeUser, where: Record<string, any> = {}): boolean {
  if (where.id !== undefined && u.id !== where.id) return false;
  if (where.role !== undefined && u.role !== where.role) return false;
  if (where.clientId !== undefined && u.clientId !== where.clientId) return false;
  if (where.status !== undefined && u.status !== where.status) return false;
  if ('deletedAt' in where && where.deletedAt === null && u.deletedAt !== null) return false;
  const grant = where.gifsyTenantGrants?.some?.clientId;
  if (grant !== undefined && !(u.grants ?? []).includes(grant)) return false;
  return true;
}

const mockPrisma = {
  ticket: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  user: {
    findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => USERS.find((u) => matchUser(u, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where: Record<string, any> }) => USERS.filter((u) => matchUser(u, where))),
  },
  clientDomain: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  ticketMessage: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = { writeInApp: jest.fn().mockResolvedValue({ id: 'n1' }) };
const mockMsg91 = { sendEmail: jest.fn().mockResolvedValue(undefined), isEmailConfigured: jest.fn().mockReturnValue(true) };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'cadmin1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };

describe('TicketsService', () => {
  let service: TicketsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTx.ticket.updateMany.mockResolvedValue({ count: 1 });
    mockMsg91.isEmailConfigured.mockReturnValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
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

    // Security/cosmetic: the message-count badge for a non-support reader must exclude
    // internal notes (they can't open them — see getOne), so it isn't over-counted.
    it('counts only non-internal messages for a non-support reader', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(partner, {});
      const include = mockPrisma.ticket.findMany.mock.calls[0][0].include;
      expect(include._count.select.messages).toEqual({ where: { isInternal: false } });
    });

    it('counts ALL messages for a support admin', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(gifsy, {});
      const include = mockPrisma.ticket.findMany.mock.calls[0][0].include;
      expect(include._count.select.messages).toBe(true);
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
      await expect(service.getOne(clientAdmin, 't1')).resolves.toMatchObject({ ticket: { id: 't1', createdById: 'someoneElse' } });
    });

    // Security: internal notes must NOT leak to a non-support reader (the ticket creator).
    // The DB-level filter is applied via a where clause on the messages include.
    it('filters internal messages out for a non-support reader (ticket creator)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1' });
      await service.getOne(partner, 't1');
      const include = mockPrisma.ticket.findFirst.mock.calls[0][0].include;
      expect(include.messages.where).toEqual({ isInternal: false });
    });

    // Security: a support admin sees ALL messages — no internal-note filter applied.
    it('does NOT filter internal messages for a support admin (GIFSY_ADMIN)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'someoneElse' });
      await service.getOne(gifsy, 't1');
      const include = mockPrisma.ticket.findFirst.mock.calls[0][0].include;
      expect(include.messages.where).toBeUndefined();
    });

    it('does NOT filter internal messages for a support admin (CLIENT_ADMIN)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'someoneElse' });
      await service.getOne(clientAdmin, 't1');
      const include = mockPrisma.ticket.findFirst.mock.calls[0][0].include;
      expect(include.messages.where).toBeUndefined();
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
      // first non-internal admin reply stamps firstResponseAt AND promotes OPEN→IN_PROGRESS
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { firstResponseAt: expect.any(Date), status: 'IN_PROGRESS', updatedAt: expect.any(Date) },
      });
    });

    it('does NOT overwrite firstResponseAt on a later admin reply', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: 't1', createdById: 'user1', status: 'IN_PROGRESS', firstResponseAt: new Date('2026-01-01'),
      });
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm9' });
      await service.addMessage(gifsy, 't1', { message: 'update' });
      // already responded + no status transition needed → no ticket.update at all
      expect(mockTx.ticket.update).not.toHaveBeenCalled();
    });

    it('does NOT stamp firstResponseAt for an internal note', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1', status: 'IN_PROGRESS' });
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm8' });
      await service.addMessage(gifsy, 't1', { message: 'note', isInternal: true });
      expect(mockTx.ticket.update).not.toHaveBeenCalled();
    });

    // Close-the-loop: the raiser responding to a RESOLVED ticket reopens it.
    it('reopens a RESOLVED ticket to IN_PROGRESS when the non-admin creator replies', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'user1', status: 'RESOLVED' });
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm2' });
      await service.addMessage(partner, 't1', { message: 'still broken' });
      // reopen clears resolvedAt so MTTR reflects the eventual real resolution
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'IN_PROGRESS', resolvedAt: null, updatedAt: expect.any(Date) },
      });
    });
  });

  describe('setStatus', () => {
    it('throws Forbidden when a non-admin calls it', async () => {
      await expect(service.setStatus(partner, 't1', { status: 'RESOLVED' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFound for a missing / cross-tenant ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.setStatus(gifsy, 't1', { status: 'RESOLVED' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const where = mockPrisma.ticket.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ id: 't1', clientId: 'deoleo' });
    });

    it('throws BadRequest for an invalid status', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      await expect(
        service.setStatus(gifsy, 't1', { status: 'BOGUS' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves: updates status to RESOLVED + posts a NON-internal system message + audit', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      const res = await service.setStatus(gifsy, 't1', { status: 'RESOLVED' });
      expect(res).toEqual({ message: 'Ticket status updated' });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'RESOLVED', updatedAt: expect.any(Date), resolvedAt: expect.any(Date), closedAt: null },
      });
      const msgArg = mockTx.ticketMessage.create.mock.calls[0][0].data;
      expect(msgArg.isInternal).toBe(false);
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    it('allows a CLIENT_ADMIN to close a ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', clientId: 'deoleo' });
      await service.setStatus(clientAdmin, 't1', { status: 'CLOSED' });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'CLOSED', updatedAt: expect.any(Date), closedAt: expect.any(Date) },
      });
    });
  });



  // ─── Assign / escalate / client remarks (SUPPORT-TICKETS.md) ──────────────────

  const gifsyStaff: JwtPayload = { sub: 'staff1', role: 'GIFSY_STAFF', clientId: 'deoleo', phone: '', name: 'Staff One', assumed: true };
  const misUser: JwtPayload = { sub: 'mis1', role: 'MIS_USER', clientId: 'deoleo', phone: '', name: '' };
  const salesUser: JwtPayload = { sub: 'so1', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
  const otherClientAdmin: JwtPayload = { sub: 'cadminB', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };

  const seedUsers = () => {
    USERS = [
      { id: 'admin1', name: 'Owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null },
      { id: 'staff1', name: 'Staff One', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null, grants: ['deoleo'] },
      { id: 'staffB', name: 'Staff Bajaj', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null, grants: ['bajaj'] },
      { id: 'staffGone', name: 'Inactive Staff', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'INACTIVE', deletedAt: null, grants: ['deoleo'] },
      { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, email: 'ca@deoleo.example' },
      { id: 'cadmin2', name: 'Deoleo Admin 2', role: 'CLIENT_ADMIN', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, email: null },
      { id: 'cadminB', name: 'Bajaj Admin', role: 'CLIENT_ADMIN', clientId: 'bajaj', status: 'ACTIVE', deletedAt: null, email: 'ca@bajaj.example' },
      { id: 'mis1', name: 'MIS', role: 'MIS_USER', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null },
      { id: 'user1', name: 'Outlet', role: 'WHOLESALER', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null },
    ];
  };
  const openTicket = (over: Record<string, unknown> = {}) => ({
    id: 't1', clientId: 'deoleo', ticketNumber: 'TKT-1', subject: 'Points missing', status: 'IN_PROGRESS',
    assignedToId: null, createdById: 'user1', metadata: null, ...over,
  });

  describe('listAssignees', () => {
    beforeEach(seedUsers);

    it("returns Gifsy owner + granted active staff + THIS tenant's active client admins only", async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      const { assignees } = await service.listAssignees(gifsy, 't1');
      expect(assignees.map((a) => a.id).sort()).toEqual(['admin1', 'cadmin1', 'cadmin2', 'staff1']);
      expect(assignees.find((a) => a.id === 'cadmin1')?.kind).toBe('CLIENT_ADMIN');
      expect(assignees.find((a) => a.id === 'staff1')?.kind).toBe('GIFSY');
    });

    it('staff must hold a live GifsyRole with support:read (else they could not open the ticket)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      await service.listAssignees(gifsy, 't1');
      const staffWhere = mockPrisma.user.findMany.mock.calls.map((c) => c[0].where).find((w) => w.role === 'GIFSY_STAFF');
      expect(staffWhere).toMatchObject({
        status: 'ACTIVE', deletedAt: null, clientId: 'gifsy',
        gifsyTenantGrants: { some: { clientId: 'deoleo' } },
        gifsyRole: { deletedAt: null, permissions: { has: 'support:read' } },
      });
    });

    it('is forbidden for a CLIENT_ADMIN / MIS_USER', async () => {
      await expect(service.listAssignees(clientAdmin, 't1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.listAssignees(misUser, 't1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assign', () => {
    beforeEach(seedUsers);

    it('assigns to a client admin of the ticket tenant: update + internal note + audit + bell', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      const res = await service.assign({ ...gifsy, name: 'Owner' }, 't1', { assigneeId: 'cadmin1' });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { assignedToId: 'cadmin1', updatedAt: expect.any(Date) } });
      const note = mockTx.ticketMessage.create.mock.calls[0][0].data;
      expect(note).toMatchObject({ isInternal: true, message: 'Assigned to Deoleo Admin by Owner.' });
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ action: 'ASSIGN', to: 'cadmin1' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1', url: '/admin/tickets?ticket=t1' }));
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
      expect(res.assignedTo?.id).toBe('cadmin1');
    });

    it('allows a granted GIFSY_STAFF to assign to themself (no self-bell)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      await service.assign(gifsyStaff, 't1', { assigneeId: 'staff1' });
      expect(mockTx.ticket.update).toHaveBeenCalled();
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
    });

    it('unassigns with assigneeId null', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ assignedToId: 'staff1' }));
      await service.assign({ ...gifsy, name: 'Owner' }, 't1', { assigneeId: null });
      expect(mockTx.ticket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { assignedToId: null, updatedAt: expect.any(Date) } });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.message).toBe('Unassigned by Owner.');
    });

    it('requires assigneeId to be present (no accidental unassign from an empty body)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      await expect(service.assign(gifsy, 't1', {} as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a CROSS-TENANT client admin', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      await expect(service.assign(gifsy, 't1', { assigneeId: 'cadminB' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.ticket.update).not.toHaveBeenCalled();
    });

    it('rejects staff WITHOUT a grant for the ticket tenant, inactive staff, an outlet and MIS', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      for (const id of ['staffB', 'staffGone', 'user1', 'mis1', 'nope']) {
        await expect(service.assign(gifsy, 't1', { assigneeId: id })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockTx.ticket.update).not.toHaveBeenCalled();
    });

    it('is forbidden for CLIENT_ADMIN / MIS_USER / field roles', async () => {
      for (const u of [clientAdmin, misUser, partner, salesUser]) {
        await expect(service.assign(u, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('404s a ticket outside the caller (assumed) tenant — lookup pinned to JWT clientId', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.assign(gifsy, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 't1', clientId: 'deoleo' });
    });

    it('refuses to reassign a CLOSED ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status: 'CLOSED' }));
      await expect(service.assign(gifsy, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('escalate', () => {
    beforeEach(seedUsers);

    it('no longer needs a prior assignee: escalates an UNASSIGNED ticket to a picked Gifsy user', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ assignedToId: null }));
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'urgent' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 't1', clientId: 'deoleo', status: 'IN_PROGRESS' }),
        data: { status: 'ESCALATED', priority: 'HIGH', assignedToId: 'staff1', metadata: {}, updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.isInternal).toBe(true);
      expect(mockTx.auditLog.create).toHaveBeenCalled();
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff1' }));
    });

    it('honours an explicit priority', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      await service.escalate(gifsy, 't1', { escalateTo: 'admin1', reason: 'x', priority: 'CRITICAL' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.priority).toBe('CRITICAL');
    });

    it('GLm-2: rejects a foreign / cross-tenant / client-admin target', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      for (const id of ['foreign-user', 'staffB', 'cadminB', 'cadmin1']) {
        await expect(service.escalate(gifsy, 't1', { escalateTo: id, reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('clears a pending client-remarks marker', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status: 'WAITING_ON_CLIENT', metadata: { keep: 1, clientRemarks: { requestedFromId: 'cadmin1' } } }));
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.metadata).toEqual({ keep: 1 });
    });

    it('race: closed meanwhile → 409, no note, no bell', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ updatedAt: new Date() }));
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing ticket and Forbidden for a client admin', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.escalate(clientAdmin, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('requestClientRemarks', () => {
    beforeEach(seedUsers);
    const ORIGIN = 'https://uat-app.gifsy.in';

    it('moves to WAITING_ON_CLIENT with the marker, internal note, audit, bell AND email (mocked)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ metadata: { keep: 1 } }));
      mockPrisma.clientDomain.findFirst.mockResolvedValue({ domain: 'deoleoloyalty.gifsy.in' });
      const res = await service.requestClientRemarks({ ...gifsy, name: 'Owner' }, 't1', { clientAdminId: 'cadmin1', note: 'Please confirm the invoice <b>' }, ORIGIN);

      const data = mockTx.ticket.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('WAITING_ON_CLIENT');
      expect(data.metadata).toMatchObject({
        keep: 1,
        clientRemarks: { requestedFromId: 'cadmin1', requestedFromName: 'Deoleo Admin', requestedById: 'admin1', note: 'Please confirm the invoice <b>' },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.isInternal).toBe(true);
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ action: 'REQUEST_CLIENT_REMARKS', requestedFromId: 'cadmin1' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1', url: '/admin/tickets?ticket=t1' }));

      expect(mockMsg91.sendEmail).toHaveBeenCalledTimes(1);
      const mail = mockMsg91.sendEmail.mock.calls[0][0];
      expect(mail.to).toEqual(['ca@deoleo.example']);
      expect(mail.subject).toBe('Remarks needed: ticket TKT-1');
      // staging origin → staging tenant host; user text is HTML-escaped
      expect(mail.html).toContain('https://uat-deoleoloyalty.gifsy.in/admin/tickets?ticket=t1');
      expect(mail.html).toContain('&lt;b&gt;');
      expect(res).toMatchObject({ emailSent: true });
    });

    it('builds the prod tenant link from a prod origin, defaulting to <slug>.gifsy.in', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, 'https://app.gifsy.in');
      expect(mockMsg91.sendEmail.mock.calls[0][0].html).toContain('https://deoleo.gifsy.in/admin/tickets?ticket=t1');
    });

    it('no email address → request still made, emailSent=false + reason, recorded as an internal note (never silent)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      mockPrisma.ticketMessage.create.mockResolvedValue({});
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin2', note: 'x' }, ORIGIN);
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
      expect(res).toMatchObject({ emailSent: false, emailError: expect.stringContaining('no email') });
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ isInternal: true, message: expect.stringContaining('NOT sent') }) });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.status).toBe('WAITING_ON_CLIENT');
    });

    it('SMTP failure → emailSent=false (state kept, failure noted internally)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      mockPrisma.ticketMessage.create.mockResolvedValue({});
      mockMsg91.sendEmail.mockRejectedValueOnce(new Error('relay down'));
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN);
      expect(res).toMatchObject({ emailSent: false });
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalled();
    });

    it('rejects a cross-tenant client admin and a Gifsy user as the target; no bell, no email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      for (const id of ['cadminB', 'staff1', 'user1']) {
        await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: id, note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('SMTP not configured → emailSent=false (never reported as sent), noted internally', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket());
      mockPrisma.ticketMessage.create.mockResolvedValue({});
      mockMsg91.isEmailConfigured.mockReturnValue(false);
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN);
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
      expect(res).toMatchObject({ emailSent: false, emailError: expect.stringContaining('not configured') });
    });

    it('race: closed meanwhile → 409, no bell, no email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ updatedAt: new Date() }));
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(ConflictException);
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('is Gifsy-only and refuses a CLOSED / RESOLVED ticket', async () => {
      await expect(service.requestClientRemarks(clientAdmin, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(ForbiddenException);
      for (const status of ['CLOSED', 'RESOLVED']) {
        mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status }));
        await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('no other ticket action sends an email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status: 'OPEN', firstResponseAt: null }));
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm' });
      await service.assign(gifsy, 't1', { assigneeId: 'cadmin1' });
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' });
      await service.setStatus(gifsy, 't1', { status: 'RESOLVED' });
      await service.addMessage(gifsy, 't1', { message: 'hi' });
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('replyClientRemarks', () => {
    beforeEach(seedUsers);
    const waiting = (over: Record<string, unknown> = {}) =>
      openTicket({
        status: 'WAITING_ON_CLIENT',
        assignedToId: 'staff1',
        metadata: { keep: 1, clientRemarks: { requestedFromId: 'cadmin1', requestedById: 'admin1', note: 'pls', requestedAt: new Date().toISOString() } },
        ...over,
      });

    it('stores an INTERNAL message, returns to IN_PROGRESS, clears the marker, bells Gifsy', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waiting());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 1 });
      await service.replyClientRemarks({ ...clientAdmin, name: 'Deoleo Admin' }, 't1', { message: 'Invoice is valid' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: {
          id: 't1', clientId: 'deoleo', status: 'WAITING_ON_CLIENT',
          metadata: { path: ['clientRemarks', 'requestedAt'], equals: expect.any(String) },
        },
        data: { status: 'IN_PROGRESS', metadata: { keep: 1 }, updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create).toHaveBeenCalledWith({ data: { ticketId: 't1', message: 'Invoice is valid', senderId: 'cadmin1', isInternal: true } });
      const bellUsers = mockNotifications.writeInApp.mock.calls.map((c) => c[0].userId).sort();
      expect(bellUsers).toEqual(['admin1', 'staff1']); // requester + Gifsy assignee
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('a colleague CLIENT_ADMIN of the same tenant may answer', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waiting());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 1 });
      await service.replyClientRemarks({ ...clientAdmin, sub: 'cadmin2' }, 't1', { message: 'ok' });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.senderId).toBe('cadmin2');
    });

    it("tenant isolation: another tenant's client admin gets 404 (lookup pinned to their own clientId)", async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.replyClientRemarks(otherClientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 't1', clientId: 'bajaj' });
    });

    it('only CLIENT_ADMIN (GIFSY_ADMIN passes @Roles, so the service re-checks)', async () => {
      for (const u of [gifsy, gifsyStaff, misUser, partner, salesUser]) {
        await expect(service.replyClientRemarks(u, 't1', { message: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('rejects when the ticket is not waiting on the client', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status: 'IN_PROGRESS' }));
      await expect(service.replyClientRemarks(clientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('race: Gifsy changed the status meanwhile → 409, nothing resurrected', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waiting());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.replyClientRemarks(clientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('setStatus clears a pending remarks request', () => {
    it('closing a WAITING_ON_CLIENT ticket drops the marker', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(openTicket({ status: 'WAITING_ON_CLIENT', metadata: { keep: 1, clientRemarks: { requestedFromId: 'cadmin1' } } }));
      await service.setStatus(gifsy, 't1', { status: 'CLOSED' });
      expect(mockTx.ticket.update.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', metadata: { keep: 1 } });
    });
  });

  describe('outlet / sales readers never see internal or client-remark data', () => {
    const waitingRow = () => openTicket({
      status: 'WAITING_ON_CLIENT',
      metadata: { clientRemarks: { requestedFromId: 'cadmin1', note: 'SECRET NOTE' } },
    });

    it.each([['outlet', partner], ['sales', salesUser]])('getOne (%s): internal messages filtered, metadata stripped, status masked', async (_l, reader) => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ ...waitingRow(), createdById: reader.sub });
      const { ticket } = await service.getOne(reader, 't1');
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].include.messages.where).toEqual({ isInternal: false });
      expect(ticket).not.toHaveProperty('metadata');
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(JSON.stringify(ticket)).not.toContain('SECRET NOTE');
    });

    it.each([['outlet', partner], ['sales', salesUser]])('list (%s): metadata stripped, status masked, no awaiting counts, internal-free message count', async (_l, reader) => {
      mockPrisma.ticket.findMany.mockResolvedValue([{ ...waitingRow(), createdById: reader.sub }]);
      mockPrisma.ticket.count.mockResolvedValue(1);
      const res = await service.list(reader, {});
      expect(JSON.stringify(res)).not.toContain('SECRET NOTE');
      expect((res.tickets[0] as any).status).toBe('IN_PROGRESS');
      expect(res).not.toHaveProperty('awaitingClient');
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].include._count.select.messages).toEqual({ where: { isInternal: false } });
    });

    it("list filter: a field reader's IN_PROGRESS includes WAITING_ON_CLIENT; WAITING_ON_CLIENT itself matches nothing", async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([]);
      mockPrisma.ticket.count.mockResolvedValue(0);
      await service.list(partner, { status: 'IN_PROGRESS' as never });
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where.status).toEqual({ in: ['IN_PROGRESS', 'WAITING_ON_CLIENT'] });
      await service.list(partner, { status: 'WAITING_ON_CLIENT' as never });
      expect(mockPrisma.ticket.findMany.mock.calls[1][0].where.status).toEqual({ in: [] });
    });

    it('support admins keep the full row + get awaiting counts (client admin: "mine" by marker)', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([waitingRow()]);
      mockPrisma.ticket.count.mockResolvedValue(2);
      const res = await service.list(clientAdmin, {});
      expect((res.tickets[0] as any).status).toBe('WAITING_ON_CLIENT');
      expect(res.awaitingClient).toEqual({ total: 2, mine: 2 });
      const mineWhere = mockPrisma.ticket.count.mock.calls.map((c) => c[0].where).find((w) => w.metadata);
      expect(mineWhere).toEqual({ clientId: 'deoleo', status: 'WAITING_ON_CLIENT', metadata: { path: ['clientRemarks', 'requestedFromId'], equals: 'cadmin1' } });
    });

    it('a field reader cannot post an internal message (client-remark channel)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ ...waitingRow(), createdById: 'so1' });
      await expect(service.addMessage(salesUser, 't1', { message: 'x', isInternal: true })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
