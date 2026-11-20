// Unit tests for TicketsService — tenant/access scoping, the business rules ported from the Next
// routes, and assign / escalate / client remarks / field privacy / note visibility
// (platform/docs/plans/SUPPORT-TICKETS.md).
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
  deletedAt: Date | null; email?: string | null; grants?: string[]; canReadSupport?: boolean;
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
  if (where.gifsyRole?.permissions?.has === 'support:read' && u.canReadSupport === false) return false;
  return true;
}

const mockPrisma = {
  ticket: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
  user: {
    findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => USERS.find((u) => matchUser(u, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where: Record<string, any> }) => USERS.filter((u) => matchUser(u, where))),
  },
  clientDomain: { findFirst: jest.fn(), findMany: jest.fn() },
  outlet: { findMany: jest.fn(), findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  ticketMessage: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
  $queryRaw: jest.fn(),
};

const mockNotifications = { writeInApp: jest.fn() };
const mockMsg91 = { sendEmail: jest.fn(), isEmailConfigured: jest.fn() };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: 'Owner' };
const gifsyStaff: JwtPayload = { sub: 'staff1', role: 'GIFSY_STAFF', clientId: 'deoleo', phone: '', name: 'Staff One', assumed: true };
const clientAdmin: JwtPayload = { sub: 'cadmin1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: 'Deoleo Admin' };
const misUser: JwtPayload = { sub: 'mis1', role: 'MIS_USER', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };
const salesUser: JwtPayload = { sub: 'so1', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
const otherClientAdmin: JwtPayload = { sub: 'cadminB', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };

const T0 = new Date(Date.now() - 60_000);

const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: 't1', clientId: 'deoleo', ticketNumber: 'TKT-1', subject: 'Points missing', status: 'IN_PROGRESS',
  priority: 'MEDIUM', assignedToId: null, createdById: 'user1', metadata: null, firstResponseAt: null,
  updatedAt: T0, ...over,
});

const pendingRemarks = (over: Record<string, unknown> = {}) => ({
  requestedFromId: 'cadmin1', requestedFromName: 'Deoleo Admin', requestedById: 'admin1', requestedByName: 'Owner',
  note: 'pls confirm', requestedAt: new Date(Date.now() - 30_000).toISOString(), fromStatus: 'IN_PROGRESS', ...over,
});

const waitingRow = (remarks: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ticketRow({ status: 'WAITING_ON_CLIENT', metadata: { keep: 1, clientRemarks: pendingRemarks(remarks) }, ...over });

describe('TicketsService', () => {
  let service: TicketsService;
  const prevLinkEnv = process.env.TENANT_LINK_ENV;

  beforeEach(async () => {
    jest.clearAllMocks();
    USERS = [
      { id: 'admin1', name: 'Owner', role: 'GIFSY_ADMIN', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null },
      { id: 'staff1', name: 'Staff One', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null, grants: ['deoleo'] },
      { id: 'staffNoPerm', name: 'Staff NoPerm', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null, grants: ['deoleo'], canReadSupport: false },
      { id: 'staffB', name: 'Staff Bajaj', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'ACTIVE', deletedAt: null, grants: ['bajaj'] },
      { id: 'staffGone', name: 'Inactive Staff', role: 'GIFSY_STAFF', clientId: 'gifsy', status: 'INACTIVE', deletedAt: null, grants: ['deoleo'] },
      { id: 'cadmin1', name: 'Deoleo Admin', role: 'CLIENT_ADMIN', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, email: 'ca@deoleo.example' },
      { id: 'cadmin2', name: 'Deoleo Admin 2', role: 'CLIENT_ADMIN', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, email: null },
      { id: 'cadminB', name: 'Bajaj Admin', role: 'CLIENT_ADMIN', clientId: 'bajaj', status: 'ACTIVE', deletedAt: null, email: 'ca@bajaj.example' },
      { id: 'mis1', name: 'MIS', role: 'MIS_USER', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null },
      { id: 'user1', name: 'Outlet', role: 'WHOLESALER', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null },
    ];
    mockTx.ticket.updateMany.mockResolvedValue({ count: 1 });
    mockTx.ticketMessage.create.mockResolvedValue({ id: 'm' });
    mockPrisma.ticketMessage.create.mockResolvedValue({ id: 'n' });
    mockPrisma.ticket.findMany.mockResolvedValue([]);
    mockPrisma.ticket.count.mockResolvedValue(0);
    mockPrisma.ticket.groupBy.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
    mockPrisma.clientDomain.findMany.mockResolvedValue([]);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockNotifications.writeInApp.mockResolvedValue({ id: 'n1' });
    mockMsg91.sendEmail.mockResolvedValue(undefined);
    mockMsg91.isEmailConfigured.mockReturnValue(true);
    process.env.TENANT_LINK_ENV = 'staging';
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

  afterAll(() => {
    if (prevLinkEnv === undefined) delete process.env.TENANT_LINK_ENV;
    else process.env.TENANT_LINK_ENV = prevLinkEnv;
  });

  // ─── list / getOne / addMessage (pre-existing rules) ─────────────────────────

  describe('list', () => {
    it('scopes non-admins to their own tickets', async () => {
      await service.list(partner, {});
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', deletedAt: null, createdById: 'user1' });
    });

    it('does NOT add a createdById filter for GIFSY admins', async () => {
      await service.list(gifsy, { status: 'OPEN' as never });
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', deletedAt: null, status: 'OPEN' });
    });

    it('does NOT add a createdById filter for CLIENT_ADMIN (sees all tenant tickets)', async () => {
      await service.list(clientAdmin, {});
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', deletedAt: null });
    });

    it('client admin "awaiting mine" view: only tickets waiting on THIS admin', async () => {
      await service.list(clientAdmin, { awaitingMine: 'true' });
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo', deletedAt: null, status: 'WAITING_ON_CLIENT',
        metadata: { path: ['clientRemarks', 'requestedFromId'], equals: 'cadmin1' },
      });
    });

    it('message-count badge: field → non-internal; client desk → not GIFSY_ONLY; Gifsy → all', async () => {
      await service.list(partner, {});
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].select._count.select.messages).toEqual({ where: { isInternal: false } });
      await service.list(clientAdmin, {});
      expect(mockPrisma.ticket.findMany.mock.calls[1][0].include._count.select.messages).toEqual({
        where: { OR: [{ isInternal: false }, { internalVisibility: null }, { internalVisibility: 'SHARED_WITH_CLIENT' }] },
      });
      await service.list(gifsy, {});
      expect(mockPrisma.ticket.findMany.mock.calls[2][0].include._count.select.messages).toBe(true);
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

    it('returns a ticket created by another user for a CLIENT_ADMIN', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'someoneElse' });
      await expect(service.getOne(clientAdmin, 't1')).resolves.toMatchObject({ ticket: { id: 't1', createdById: 'someoneElse' } });
    });

    it('Gifsy sees every message; the client desk never sees GIFSY_ONLY notes (legacy NULL still shown)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 't1', createdById: 'x' });
      await service.getOne(gifsy, 't1');
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].include.messages.where).toBeUndefined();
      for (const u of [clientAdmin, misUser]) {
        mockPrisma.ticket.findFirst.mockClear();
        await service.getOne(u, 't1');
        expect(mockPrisma.ticket.findFirst.mock.calls[0][0].include.messages.where).toEqual({
          OR: [{ isInternal: false }, { internalVisibility: null }, { internalVisibility: 'SHARED_WITH_CLIENT' }],
        });
      }
    });

    it('labels every thread message for admins (outlet owner / sales · designation / Gifsy / client admin)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: 't1', createdById: 'u1', messages: [
          { id: 'a', sender: { name: 'login', role: 'WHOLESALER', channelPartner: { ownerName: 'Ramesh Gupta' } } },
          { id: 'b', sender: { name: 'Meera', role: 'SALES_ISR', salesUser: { hierarchyLevel: { name: 'ISR', code: 'ISR' } } } },
          { id: 'c', sender: { name: 'Owner', role: 'GIFSY_ADMIN' } },
          { id: 'd', sender: { name: 'Anita', role: 'CLIENT_ADMIN' } },
        ],
      });
      const { ticket } = await service.getOne(gifsy, 't1');
      const labels = (ticket.messages as any[]).map((m) => [m.senderLabel, m.senderKind]);
      expect(labels).toEqual([
        ['Outlet owner — Ramesh Gupta', 'OUTLET_OWNER'],
        ['Meera · ISR', 'SALES'],
        ['Owner · Gifsy support', 'STAFF'],
        ['Anita · Client admin', 'STAFF'],
      ]);
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].include.messages.include.sender.select.salesUser).toBeDefined();
    });
  });

  describe('addMessage', () => {
    it('rejects messages on a CLOSED ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'CLOSED' }));
      await expect(service.addMessage(partner, 't1', { message: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects internal notes from field roles', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'OPEN' }));
      await expect(service.addMessage(partner, 't1', { message: 'secret', isInternal: true })).rejects.toBeInstanceOf(ForbiddenException);
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'OPEN', createdById: 'so1' }));
      await expect(service.addMessage(salesUser, 't1', { message: 'x', isInternal: true })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('creates a message and promotes an OPEN ticket to IN_PROGRESS when an admin replies', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'OPEN' }));
      mockTx.ticketMessage.create.mockResolvedValue({ id: 'm1' });
      const res = await service.addMessage(gifsy, 't1', { message: 'on it' });
      expect(res).toEqual({ message: { id: 'm1' } });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'OPEN', updatedAt: T0 },
        data: { firstResponseAt: expect.any(Date), status: 'IN_PROGRESS', updatedAt: expect.any(Date) },
      });
    });

    it('does NOT overwrite firstResponseAt on a later admin reply', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ firstResponseAt: new Date(Date.now() - 86_400_000) }));
      await service.addMessage(gifsy, 't1', { message: 'update' });
      // no transition → only a status-pinned touch (no firstResponseAt overwrite)
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'IN_PROGRESS' },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('reopens a RESOLVED ticket to IN_PROGRESS when the creator replies', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'RESOLVED' }));
      await service.addMessage(partner, 't1', { message: 'still broken' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'RESOLVED', updatedAt: T0 },
        data: { status: 'IN_PROGRESS', resolvedAt: null, updatedAt: expect.any(Date) },
      });
    });

    it('note visibility: Gifsy internal note defaults to GIFSY_ONLY, may be shared; client-desk note is always SHARED', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.addMessage(gifsy, 't1', { message: 'n', isInternal: true });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.internalVisibility).toBe('GIFSY_ONLY');
      await service.addMessage(gifsyStaff, 't1', { message: 'n', isInternal: true, visibility: 'SHARED_WITH_CLIENT' });
      expect(mockTx.ticketMessage.create.mock.calls[1][0].data.internalVisibility).toBe('SHARED_WITH_CLIENT');
      await service.addMessage(clientAdmin, 't1', { message: 'n', isInternal: true, visibility: 'GIFSY_ONLY' });
      expect(mockTx.ticketMessage.create.mock.calls[2][0].data.internalVisibility).toBe('SHARED_WITH_CLIENT');
      await service.addMessage(gifsy, 't1', { message: 'public reply' });
      expect(mockTx.ticketMessage.create.mock.calls[3][0].data).not.toHaveProperty('internalVisibility');
    });

    it('race: a reply never revives a ticket closed / escalated meanwhile (409, no message written)', async () => {
      for (const status of ['OPEN', 'RESOLVED', 'IN_PROGRESS']) {
        mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status }));
        mockTx.ticket.updateMany.mockResolvedValueOnce({ count: 0 }); // closed / escalated after the read
        const who = status === 'RESOLVED' ? partner : gifsy;
        await expect(service.addMessage(who, 't1', { message: 'x' })).rejects.toBeInstanceOf(ConflictException);
      }
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
    });

    it('an ESCALATED ticket stays ESCALATED when anyone replies', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'ESCALATED', firstResponseAt: new Date(Date.now() - 1000) }));
      await service.addMessage(gifsy, 't1', { message: 'x' });
      const call = mockTx.ticket.updateMany.mock.calls[0][0];
      expect(call.where.status).toBe('ESCALATED');
      expect(call.data).not.toHaveProperty('status');
    });
  });

  // ─── setStatus ────────────────────────────────────────────────────────────────

  describe('setStatus', () => {
    it('throws Forbidden for a field role and NotFound for a cross-tenant ticket', async () => {
      await expect(service.setStatus(partner, 't1', { status: 'RESOLVED' })).rejects.toBeInstanceOf(ForbiddenException);
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.setStatus(gifsy, 't1', { status: 'RESOLVED' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 't1', clientId: 'deoleo' });
    });

    it('throws BadRequest for an invalid status', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await expect(service.setStatus(gifsy, 't1', { status: 'BOGUS' as never })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves with an optimistic guard (status + updatedAt), a NON-internal system message and an audit', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.setStatus(gifsy, 't1', { status: 'RESOLVED' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'IN_PROGRESS', updatedAt: T0 },
        data: { status: 'RESOLVED', updatedAt: expect.any(Date), resolvedAt: expect.any(Date), closedAt: null },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.isInternal).toBe(false);
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    it('race: changed meanwhile → 409, nothing written', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.setStatus(gifsy, 't1', { status: 'CLOSED' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
    });

    it('allows a CLIENT_ADMIN to close a normal ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.setStatus(clientAdmin, 't1', { status: 'CLOSED' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', closedAt: expect.any(Date) });
    });

    it('the client desk cannot resolve/close/reopen a ticket WAITING on their remarks (reply first)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      for (const u of [clientAdmin, misUser]) {
        for (const status of ['RESOLVED', 'CLOSED', 'IN_PROGRESS'] as const) {
          await expect(service.setStatus(u, 't1', { status })).rejects.toBeInstanceOf(ConflictException);
        }
      }
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('Gifsy closing a WAITING ticket cancels the request explicitly: marker cleared, SHARED note, client bell', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      await service.setStatus(gifsy, 't1', { status: 'CLOSED' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED', metadata: { keep: 1 } });
      const cancel = mockTx.ticketMessage.create.mock.calls.map((c) => c[0].data).find((d) => /withdrawn the request/.test(d.message));
      expect(cancel).toMatchObject({ isInternal: true, internalVisibility: 'SHARED_WITH_CLIENT' });
      expect(cancel.message).toBe('Gifsy support has withdrawn the request for remarks from Deoleo Admin — the ticket was Closed.');
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1', subject: expect.stringMatching(/no longer needed/) }));
    });
  });

  // ─── assign ───────────────────────────────────────────────────────────────────

  describe('listAssignees', () => {
    it("returns Gifsy owner + granted staff WITH support:read + THIS tenant's active client admins only", async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      const { assignees } = await service.listAssignees(gifsy, 't1');
      expect(assignees.map((a) => a.id).sort()).toEqual(['admin1', 'cadmin1', 'cadmin2', 'staff1']);
      const staffWhere = mockPrisma.user.findMany.mock.calls.map((c) => c[0].where).find((w) => w.role === 'GIFSY_STAFF');
      expect(staffWhere).toMatchObject({ gifsyRole: { deletedAt: null, permissions: { has: 'support:read' } } });
    });

    it('is forbidden for a CLIENT_ADMIN / MIS_USER', async () => {
      await expect(service.listAssignees(clientAdmin, 't1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.listAssignees(misUser, 't1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assign', () => {
    it('assigns to a client admin of the ticket tenant: guarded update + GIFSY_ONLY note + audit + bell, no email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      const res = await service.assign(gifsy, 't1', { assigneeId: 'cadmin1' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'IN_PROGRESS', updatedAt: T0 },
        data: { assignedToId: 'cadmin1', updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data).toMatchObject({
        isInternal: true, internalVisibility: 'GIFSY_ONLY', message: 'Assigned to Deoleo Admin by Owner.',
      });
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ action: 'ASSIGN', to: 'cadmin1' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1', url: '/admin/tickets?ticket=t1' }));
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
      expect(res.assignedTo?.id).toBe('cadmin1');
    });

    it('a granted staff may self-assign (no self-bell); null unassigns; empty body is refused', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.assign(gifsyStaff, 't1', { assigneeId: 'staff1' });
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ assignedToId: 'staff1' }));
      await service.assign(gifsy, 't1', { assigneeId: null });
      expect(mockTx.ticket.updateMany.mock.calls[1][0].data).toEqual({ assignedToId: null, updatedAt: expect.any(Date) });
      await expect(service.assign(gifsy, 't1', {} as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects cross-tenant / ungranted / permissionless / inactive / outlet / MIS assignees', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      for (const id of ['cadminB', 'staffB', 'staffNoPerm', 'staffGone', 'user1', 'mis1', 'nope']) {
        await expect(service.assign(gifsy, 't1', { assigneeId: id })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('is forbidden for CLIENT_ADMIN / MIS_USER / field roles; 404 outside the assumed tenant; refuses CLOSED', async () => {
      for (const u of [clientAdmin, misUser, partner, salesUser]) {
        await expect(service.assign(u, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(ForbiddenException);
      }
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.assign(gifsy, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(NotFoundException);
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'CLOSED' }));
      await expect(service.assign(gifsy, 't1', { assigneeId: 'cadmin1' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── escalate ─────────────────────────────────────────────────────────────────

  describe('escalate', () => {
    it('no longer needs a prior assignee: escalates to a picked Gifsy user (GIFSY_ONLY note, bell)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'urgent' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'IN_PROGRESS', updatedAt: T0 },
        data: { status: 'ESCALATED', priority: 'HIGH', assignedToId: 'staff1', metadata: {}, updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data).toMatchObject({ isInternal: true, internalVisibility: 'GIFSY_ONLY' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff1' }));
    });

    it('honours an explicit priority; rejects foreign / cross-tenant / client-admin targets', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await service.escalate(gifsy, 't1', { escalateTo: 'admin1', reason: 'x', priority: 'CRITICAL' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.priority).toBe('CRITICAL');
      for (const id of ['foreign-user', 'staffB', 'cadminB', 'cadmin1']) {
        await expect(service.escalate(gifsy, 't1', { escalateTo: id, reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('escalating a WAITING ticket cancels the request explicitly (SHARED note + client bell)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.metadata).toEqual({ keep: 1 });
      const cancel = mockTx.ticketMessage.create.mock.calls.map((c) => c[0].data).find((d) => /withdrawn the request/.test(d.message));
      expect(cancel).toMatchObject({ internalVisibility: 'SHARED_WITH_CLIENT' });
      // client-visible text is NEUTRAL — the internal escalation is never named to the client
      expect(cancel.message).toBe('Gifsy support has withdrawn the request for remarks from Deoleo Admin.');
      const shared = mockTx.ticketMessage.create.mock.calls.map((c) => c[0].data).filter((d) => d.internalVisibility === 'SHARED_WITH_CLIENT');
      expect(shared.every((d) => !/escalat/i.test(d.message))).toBe(true);
      const internal = mockTx.ticketMessage.create.mock.calls.map((c) => c[0].data).find((d) => d.internalVisibility === 'GIFSY_ONLY');
      expect(internal.message).toMatch(/withdrew the pending remarks request to Deoleo Admin/);
      const bell = mockNotifications.writeInApp.mock.calls.map((c) => c[0]).find((b) => b.userId === 'cadmin1');
      expect(bell.body).toBe('Gifsy support has withdrawn the request for your remarks.');
    });

    it('race: closed meanwhile → 409, no note, no bell; NotFound / Forbidden as before', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.escalate(clientAdmin, 't1', { escalateTo: 'staff1', reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── request client remarks ───────────────────────────────────────────────────

  describe('requestClientRemarks', () => {
    const ORIGIN = 'http://localhost:4000';

    it('WAITING_ON_CLIENT + marker (with fromStatus) + SHARED note + audit + bell; email AFTER commit, outcome noted', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'ESCALATED', metadata: { keep: 1 } }));
      mockPrisma.clientDomain.findMany.mockResolvedValue([{ domain: 'deoleoloyalty.gifsy.in', isPrimary: true }]);
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'Please confirm <b>' }, ORIGIN);

      const data = mockTx.ticket.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('WAITING_ON_CLIENT');
      expect(data.metadata).toMatchObject({
        keep: 1,
        clientRemarks: { requestedFromId: 'cadmin1', requestedById: 'admin1', note: 'Please confirm <b>', fromStatus: 'ESCALATED' },
      });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data).toMatchObject({ internalVisibility: 'SHARED_WITH_CLIENT' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1', url: '/admin/tickets?ticket=t1' }));
      expect(res).toMatchObject({ emailSent: true });
      expect(mockMsg91.sendEmail).toHaveBeenCalledTimes(1);
      const mail = mockMsg91.sendEmail.mock.calls[0][0];
      expect(mail.to).toEqual(['ca@deoleo.example']);
      expect(mail.subject).toBe('Remarks needed: ticket TKT-1');
      // staging SERVER config → uat- tenant host even though the caller came via localhost
      expect(mail.html).toContain('https://uat-deoleoloyalty.gifsy.in/admin/tickets?ticket=t1');
      expect(mail.html).toContain('&lt;b&gt;');
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ internalVisibility: 'GIFSY_ONLY', message: expect.stringMatching(/^Email sent to Deoleo Admin/) }),
      });
    });

    it('the email is sent IN the request (after commit) — the response reports the real outcome', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      const order: string[] = [];
      mockTx.auditLog.create.mockImplementation(async () => { order.push('commit'); });
      mockMsg91.sendEmail.mockImplementation(async () => { order.push('email'); });
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN);
      expect(order).toEqual(['commit', 'email']);
      expect(res).toMatchObject({ emailSent: true });
      expect(res).not.toHaveProperty('emailError');
    });

    it('relay failure → emailSent=false + reason, and a GIFSY_ONLY note (never silent)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockMsg91.sendEmail.mockRejectedValue(new Error('relay down'));
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN);
      expect(res).toMatchObject({ emailSent: false, emailError: expect.stringContaining('relay') });
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ internalVisibility: 'GIFSY_ONLY', message: expect.stringContaining('NOT sent') }),
      });
    });

    it('no address / SMTP not configured → NOT_SENT + reason in the response and the thread; no send', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      const a = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin2', note: 'x' }, ORIGIN);
      expect(a).toMatchObject({ emailSent: false, emailError: expect.stringContaining('no email') });
      mockMsg91.isEmailConfigured.mockReturnValue(false);
      const b = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN);
      expect(b).toMatchObject({ emailSent: false, emailError: expect.stringContaining('not configured') });
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalledTimes(2);
    });

    it('idempotent: a request already pending for the SAME client admin is not re-sent', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'again' }, ORIGIN);
      expect(res).toMatchObject({ alreadyPending: true });
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('asking a DIFFERENT client admin replaces the request: old one cancelled (note + bell), original fromStatus kept', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: 'ESCALATED' }));
      await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin2', note: 'x' }, ORIGIN);
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.metadata.clientRemarks).toMatchObject({ requestedFromId: 'cadmin2', fromStatus: 'ESCALATED' });
      expect(mockTx.ticketMessage.create.mock.calls.some((c) => /withdrawn the request for remarks from Deoleo Admin/.test(c[0].data.message))).toBe(true);
      expect(mockNotifications.writeInApp.mock.calls.map((c) => c[0].userId)).toEqual(expect.arrayContaining(['cadmin1', 'cadmin2']));
    });

    it('rejects a cross-tenant client admin / a Gifsy user / an outlet as the target; no bell, no email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      for (const id of ['cadminB', 'staff1', 'user1']) {
        await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: id, note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('Gifsy-only; refuses CLOSED / RESOLVED; race → 409 with no bell/email', async () => {
      await expect(service.requestClientRemarks(clientAdmin, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(ForbiddenException);
      for (const status of ['CLOSED', 'RESOLVED']) {
        mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status }));
        await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(BadRequestException);
      }
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, ORIGIN)).rejects.toBeInstanceOf(ConflictException);
      expect(mockNotifications.writeInApp).not.toHaveBeenCalled();
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('no other ticket action sends an email', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ status: 'OPEN' }));
      await service.assign(gifsy, 't1', { assigneeId: 'cadmin1' });
      await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' });
      await service.setStatus(gifsy, 't1', { status: 'RESOLVED' });
      await service.addMessage(gifsy, 't1', { message: 'hi' });
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });
  });

  // ─── client admin reply ───────────────────────────────────────────────────────

  describe('replyClientRemarks', () => {
    it('SHARED internal message, back to IN_PROGRESS, marker cleared, pinned to the request read, bells Gifsy', async () => {
      const row = waitingRow({}, { assignedToId: 'staff1' });
      mockPrisma.ticket.findFirst.mockResolvedValue(row);
      const res = await service.replyClientRemarks(clientAdmin, 't1', { message: 'Invoice is valid' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: {
          id: 't1', clientId: 'deoleo', status: 'WAITING_ON_CLIENT',
          metadata: { path: ['clientRemarks', 'requestedAt'], equals: (row.metadata as any).clientRemarks.requestedAt },
        },
        data: { status: 'IN_PROGRESS', metadata: { keep: 1 }, updatedAt: expect.any(Date) },
      });
      expect(mockTx.ticketMessage.create).toHaveBeenCalledWith({
        data: { ticketId: 't1', senderId: 'cadmin1', message: 'Invoice is valid', isInternal: true, internalVisibility: 'SHARED_WITH_CLIENT', isClientRemarks: true },
      });
      expect(mockNotifications.writeInApp.mock.calls.map((c) => c[0].userId).sort()).toEqual(['admin1', 'staff1']);
      expect(res.status).toBe('IN_PROGRESS');
    });

    it('restores ESCALATED when the remarks were requested on an escalated ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: 'ESCALATED' }));
      const res = await service.replyClientRemarks(clientAdmin, 't1', { message: 'ok' });
      expect(mockTx.ticket.updateMany.mock.calls[0][0].data.status).toBe('ESCALATED');
      expect(res.status).toBe('ESCALATED');
    });

    it('a colleague CLIENT_ADMIN of the same tenant may answer; another tenant gets 404 (pinned lookup)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      await service.replyClientRemarks({ ...clientAdmin, sub: 'cadmin2' }, 't1', { message: 'ok' });
      expect(mockTx.ticketMessage.create.mock.calls[0][0].data.senderId).toBe('cadmin2');
      mockPrisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.replyClientRemarks(otherClientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.ticket.findFirst.mock.calls.at(-1)?.[0].where).toEqual({ id: 't1', clientId: 'bajaj' });
    });

    it('only CLIENT_ADMIN (GIFSY_ADMIN passes @Roles, so the service re-checks); not-waiting → 400; race → 409', async () => {
      for (const u of [gifsy, gifsyStaff, misUser, partner, salesUser]) {
        await expect(service.replyClientRemarks(u, 't1', { message: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
      }
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await expect(service.replyClientRemarks(clientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(BadRequestException);
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      mockTx.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.replyClientRemarks(clientAdmin, 't1', { message: 'x' })).rejects.toBeInstanceOf(ConflictException);
      expect(mockTx.ticketMessage.create).not.toHaveBeenCalled();
    });
  });

  // ─── field-reader privacy ─────────────────────────────────────────────────────

  describe('outlet / sales readers: no internal data, no assignee, no priority, no ESCALATED / WAITING', () => {
    const leaky = (createdById: string) => ({
      ...waitingRow({ note: 'SECRET NOTE' }, { createdById, assignedToId: 'staff1', priority: 'CRITICAL', assignedTo: { id: 'staff1', name: 'Staff One' } }),
    });

    it.each([['outlet', partner], ['sales', salesUser]])('getOne (%s): allow-listed select + masked + no admin keys', async (_l, reader) => {
      mockPrisma.ticket.findFirst.mockResolvedValue(leaky(reader.sub));
      const { ticket } = await service.getOne(reader, 't1');
      const args = mockPrisma.ticket.findFirst.mock.calls[0][0];
      expect(args.include).toBeUndefined();
      for (const k of ['assignedTo', 'assignedToId', 'priority', 'metadata']) expect(args.select).not.toHaveProperty(k);
      expect(args.select.messages.where).toEqual({ isInternal: false });
      for (const k of ['assignedTo', 'assignedToId', 'priority', 'metadata']) expect(ticket).not.toHaveProperty(k);
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(JSON.stringify(ticket)).not.toContain('SECRET NOTE');
    });

    it.each([['outlet', partner], ['sales', salesUser]])('ESCALATED is shown as IN_PROGRESS to a %s reader', async (_l, reader) => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow({ createdById: reader.sub, status: 'ESCALATED', priority: 'HIGH' }));
      const { ticket } = await service.getOne(reader, 't1');
      expect(ticket.status).toBe('IN_PROGRESS');
      expect(ticket).not.toHaveProperty('priority');
    });

    it.each([['outlet', partner], ['sales', salesUser]])('list (%s): allow-listed select, masked, no awaiting counts', async (_l, reader) => {
      mockPrisma.ticket.findMany.mockResolvedValue([leaky(reader.sub), ticketRow({ createdById: reader.sub, status: 'ESCALATED' })]);
      const res = await service.list(reader, {});
      const args = mockPrisma.ticket.findMany.mock.calls[0][0];
      expect(args.include).toBeUndefined();
      for (const k of ['assignedTo', 'assignedToId', 'priority', 'metadata']) expect(args.select).not.toHaveProperty(k);
      expect((res.tickets as any[]).map((t) => t.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
      for (const t of res.tickets as any[]) for (const k of ['assignedTo', 'assignedToId', 'priority', 'metadata']) expect(t).not.toHaveProperty(k);
      expect(res).not.toHaveProperty('awaitingClient');
    });

    it("list filter: a field reader's IN_PROGRESS matches the masked states; the masked states themselves match nothing", async () => {
      await service.list(partner, { status: 'IN_PROGRESS' as never });
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where.status).toEqual({ in: ['IN_PROGRESS', 'WAITING_ON_CLIENT', 'ESCALATED'] });
      for (const s of ['WAITING_ON_CLIENT', 'ESCALATED']) {
        mockPrisma.ticket.findMany.mockClear();
        await service.list(partner, { status: s as never });
        expect(mockPrisma.ticket.findMany.mock.calls[0][0].where.status).toEqual({ in: [] });
      }
    });

    it('create returns the field projection to a field raiser', async () => {
      mockPrisma.ticket.create.mockResolvedValue({ id: 'new' });
      await service.create(partner, { category: 'POINTS' as never, subject: 's', description: 'd' });
      const args = mockPrisma.ticket.create.mock.calls[0][0];
      expect(args.include).toBeUndefined();
      expect(args.select).not.toHaveProperty('assignedToId');
      expect(args.select.messages).toEqual({ where: { isInternal: false } });
    });

    it('support admins keep the full row + awaiting counts', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue([waitingRow()]);
      mockPrisma.ticket.count.mockResolvedValue(2);
      const res = await service.list(clientAdmin, {});
      expect((res.tickets[0] as any).status).toBe('WAITING_ON_CLIENT');
      expect(res.awaitingClient).toEqual({ total: 2, mine: 2 });
    });
  });

  // ─── round 2: cancel request & resume; server-side list filters + summary ────

  describe('cancelClientRemarks', () => {
    it('Gifsy cancels: back to the pre-request status, marker cleared, SHARED note, client bell, audit', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: 'ESCALATED' }));
      const res = await service.cancelClientRemarks(gifsy, 't1', { reason: 'solved by phone' });
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', clientId: 'deoleo', status: 'WAITING_ON_CLIENT', updatedAt: T0 },
        data: { status: 'ESCALATED', metadata: { keep: 1 }, updatedAt: expect.any(Date) },
      });
      const note = mockTx.ticketMessage.create.mock.calls[0][0].data;
      expect(note).toMatchObject({ internalVisibility: 'SHARED_WITH_CLIENT' });
      expect(note.message).toBe('Gifsy support has withdrawn the request for remarks from Deoleo Admin.');
      // the typed reason is Gifsy-only
      expect(mockTx.ticketMessage.create.mock.calls[1][0].data).toMatchObject({ internalVisibility: 'GIFSY_ONLY', message: 'Remarks request withdrawn: solved by phone' });
      expect(mockNotifications.writeInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cadmin1' }));
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({ action: 'CANCEL_CLIENT_REMARKS' });
      expect(res.status).toBe('ESCALATED');
    });

    it('unknown / waiting pre-status falls back to IN_PROGRESS; not waiting → 400; client desk → 403; race → 409', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: undefined }));
      expect((await service.cancelClientRemarks(gifsy, 't1', {})).status).toBe('IN_PROGRESS');
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      await expect(service.cancelClientRemarks(gifsy, 't1', {})).rejects.toBeInstanceOf(BadRequestException);
      for (const u of [clientAdmin, misUser, partner]) {
        await expect(service.cancelClientRemarks(u, 't1', {})).rejects.toBeInstanceOf(ForbiddenException);
      }
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      mockTx.ticket.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancelClientRemarks(gifsy, 't1', {})).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('admin list: server-side filters + tenant summary', () => {
    it('priorities / source / q are applied in the DB (q also matches referenced outlets by code)', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 't-ref' }]);
      await service.list(gifsy, { priorities: 'high,CRITICAL', source: 'sales', q: 'DEO-09' });
      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.AND[0]).toEqual({ priority: { in: ['HIGH', 'CRITICAL'] } });
      expect(where.AND[1].createdBy.role.in).toContain('SALES_ISR');
      const or = where.AND[2].OR;
      expect(or).toContainEqual({ ticketNumber: { contains: 'DEO-09', mode: 'insensitive' } });
      expect(or).toContainEqual({ id: { in: ['t-ref'] } });
      // one uncapped DB join (no `take`, no outlet id list), tenant-pinned
      const sql = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(sql.strings.join('?')).toMatch(/JOIN "outlets"/);
      expect(sql.strings.join('?')).not.toMatch(/LIMIT/i);
      expect(sql.values).toEqual(['deoleo', 'OUTLET', '%DEO-09%', '%DEO-09%']);
      expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
      // the total counts the FILTERED set
      expect(mockPrisma.ticket.count.mock.calls[0][0].where).toEqual(where);
    });

    it('invalid priorities → 400; field readers ignore admin filters', async () => {
      await expect(service.list(gifsy, { priorities: 'BOGUS' })).rejects.toBeInstanceOf(BadRequestException);
      await service.list(partner, { priorities: 'HIGH', q: 'x', source: 'sales' });
      expect(mockPrisma.ticket.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', deletedAt: null, createdById: 'user1' });
    });

    it('summary is tenant-wide (not the loaded page) and only for support admins', async () => {
      mockPrisma.ticket.groupBy.mockResolvedValue([
        { status: 'OPEN', _count: { _all: 3 } },
        { status: 'IN_PROGRESS', _count: { _all: 2 } },
        { status: 'ESCALATED', _count: { _all: 1 } },
        { status: 'WAITING_ON_CLIENT', _count: { _all: 1 } },
        { status: 'RESOLVED', _count: { _all: 4 } },
        { status: 'CLOSED', _count: { _all: 5 } },
      ]);
      mockPrisma.ticket.count.mockResolvedValue(2);
      const res = await service.list(clientAdmin, {});
      expect(res.summary).toEqual({ total: 16, open: 3, inProgress: 4, resolved: 9, highPriority: 2 });
      expect(mockPrisma.ticket.groupBy.mock.calls[0][0].where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect(mockPrisma.ticket.count.mock.calls.every((c) => c[0].where.deletedAt === null)).toBe(true);
      const field = await service.list(partner, {});
      expect(field).not.toHaveProperty('summary');
    });
  });

  // ─── round 3 ─────────────────────────────────────────────────────────────────

  describe('round 3', () => {
    it('one resume rule for reply AND cancel: ESCALATED / PENDING_USER kept, OPEN / IN_PROGRESS → IN_PROGRESS', async () => {
      for (const [from, expected] of [['ESCALATED', 'ESCALATED'], ['PENDING_USER', 'PENDING_USER'], ['OPEN', 'IN_PROGRESS'], ['IN_PROGRESS', 'IN_PROGRESS']]) {
        mockTx.ticket.updateMany.mockClear();
        mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: from }));
        expect((await service.replyClientRemarks(clientAdmin, 't1', { message: 'ok' })).status).toBe(expected);
        mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow({ fromStatus: from }));
        expect((await service.cancelClientRemarks(gifsy, 't1', {})).status).toBe(expected);
      }
    });

    it('a recipient lookup failure is reported as such — never as "no email on file"', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockPrisma.user.findFirst.mockImplementationOnce(async () => { throw new Error('db down'); });
      // (the first user.findFirst is actorName → JWT name is set, so the lookup above is the recipient)
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, 'x');
      expect(res).toMatchObject({ emailSent: false, emailError: expect.stringContaining('could not be looked up') });
      expect((res as any).emailError).not.toMatch(/no email/);
    });

    it('a domain lookup failure is reported as such', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockPrisma.clientDomain.findMany.mockRejectedValue(new Error('db down'));
      const res = await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, 'x');
      expect(res).toMatchObject({ emailSent: false, emailError: expect.stringContaining('web address could not be resolved') });
      expect(mockMsg91.sendEmail).not.toHaveBeenCalled();
    });

    it('no primary domain → slug host, and the outcome note says so', async () => {
      process.env.TENANT_LINK_ENV = 'production';
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      mockPrisma.clientDomain.findMany.mockResolvedValue([{ domain: 'uat-deoleoloyalty.gifsy.in', isPrimary: false }]);
      await service.requestClientRemarks(gifsy, 't1', { clientAdminId: 'cadmin1', note: 'x' }, 'x');
      expect(mockMsg91.sendEmail.mock.calls[0][0].html).toContain('https://deoleo.gifsy.in/admin/tickets?ticket=t1');
      expect(mockPrisma.ticketMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ message: expect.stringContaining('no primary domain is registered') }),
      });
    });

    it('escalate / setStatus report which pending request they cancelled (UI shows it — never silent)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      expect(await service.escalate(gifsy, 't1', { escalateTo: 'staff1', reason: 'x' })).toMatchObject({ cancelledRemarksFrom: 'Deoleo Admin' });
      mockPrisma.ticket.findFirst.mockResolvedValue(waitingRow());
      expect(await service.setStatus(gifsy, 't1', { status: 'RESOLVED' })).toMatchObject({ cancelledRemarksFrom: 'Deoleo Admin' });
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRow());
      expect(await service.setStatus(gifsy, 't1', { status: 'RESOLVED' })).toMatchObject({ cancelledRemarksFrom: null });
    });

    it('counts (summary + awaiting) are computed on page 1 only — Load more never recomputes them', async () => {
      const res = await service.list(gifsy, { page: 2 });
      expect(res).not.toHaveProperty('summary');
      expect(res).not.toHaveProperty('awaitingClient');
      expect(mockPrisma.ticket.groupBy).not.toHaveBeenCalled();
    });
  });
});
