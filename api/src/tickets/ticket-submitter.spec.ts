// "Raised by" + ticket outlet resolution (SUPPORT-TICKETS.md). Pure helpers + the service wiring
// (support-admin enrichment, outlet capture/validation at create) + the ticket-aging Excel columns.
// Run: npx jest src/tickets/ticket-submitter.spec.ts

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { describeRaisedBy, resolveTicketOutlet } from './ticket-submitter';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildTicketAgingRow, ticketAgingXlsxRows } from '../admin-programs/reports/report-helpers';

const owner = {
  id: 'u1', name: 'login name', role: 'WHOLESALER',
  channelPartner: { id: 'p1', ownerName: 'Ramesh Gupta', outlets: [{ id: 'o1', outletCode: 'DEO-0042', name: 'Gupta Stores' }], _count: { outlets: 1 } },
  salesUser: null,
};
const isr = {
  id: 'u2', name: 'Meera Iyer', role: 'SALES_ISR', channelPartner: null,
  salesUser: { employeeCode: 'E1', hierarchyLevel: { name: 'Territory Sales Officer', code: 'ISR' } },
};

describe('describeRaisedBy', () => {
  it('outlet owner → "Outlet owner — <owner name>" (owner name, not the login name)', () => {
    expect(describeRaisedBy(owner as never)).toEqual({
      kind: 'OUTLET_OWNER', name: 'Ramesh Gupta', designation: null, label: 'Outlet owner — Ramesh Gupta',
    });
  });

  it('sales person → "<name> · <tenant hierarchy label>"', () => {
    expect(describeRaisedBy(isr as never).label).toBe('Meera Iyer · Territory Sales Officer');
  });

  it('sales person falls back to the level code, then the role', () => {
    expect(describeRaisedBy({ ...isr, salesUser: { employeeCode: 'E', hierarchyLevel: { name: '', code: 'SO' } } } as never).label)
      .toBe('Meera Iyer · SO');
    expect(describeRaisedBy({ ...isr, role: 'SALES_ASM', salesUser: null } as never).label).toBe('Meera Iyer · ASM');
  });

  it('an admin raiser is labelled with their role; unknown creator never crashes', () => {
    expect(describeRaisedBy({ name: 'Anita', role: 'CLIENT_ADMIN' } as never).label).toBe('Anita · Client admin');
    expect(describeRaisedBy(null).label).toBe('Unknown');
  });
});

describe('resolveTicketOutlet', () => {
  const ref = new Map([['o9', { id: 'o9', outletCode: 'DEO-0900', name: 'Ref Outlet' }]]);

  it('uses the outlet stored on the ticket first', () => {
    expect(resolveTicketOutlet({ referenceType: 'OUTLET', referenceId: 'o9' }, isr as never, ref))
      .toEqual({ id: 'o9', outletCode: 'DEO-0900', name: 'Ref Outlet', source: 'TICKET' });
  });

  it("partner-raised without a stored outlet → the owner's primary outlet (+ count)", () => {
    expect(resolveTicketOutlet({}, owner as never, ref)).toEqual({
      id: 'o1', outletCode: 'DEO-0042', name: 'Gupta Stores', source: 'OWNER_PRIMARY', ownerOutletCount: 1,
    });
  });

  it('sales "own issue" / legacy sales ticket with no stored outlet → null (shown as —)', () => {
    expect(resolveTicketOutlet({ referenceType: null, referenceId: null }, isr as never, ref)).toBeNull();
  });

  it('a reference to an outlet outside the tenant (not loaded) does not resolve', () => {
    expect(resolveTicketOutlet({ referenceType: 'OUTLET', referenceId: 'foreign' }, isr as never, new Map())).toBeNull();
  });
});

describe('TicketsService — raised-by / outlet wiring', () => {
  const tx = { ticket: { update: jest.fn(), updateMany: jest.fn() }, ticketMessage: { create: jest.fn() }, auditLog: { create: jest.fn() } };
  const prisma = {
    ticket: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'new' }), findFirst: jest.fn() },
    outlet: { findMany: jest.fn(), findFirst: jest.fn() },
    salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
    salesUserAssignment: { findFirst: jest.fn() },
    channelPartner: { findFirst: jest.fn() },
    user: { findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  let service: TicketsService;
  const clientAdmin: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
  const so: JwtPayload = { sub: 'u-so', role: 'SALES_SO', clientId: 'deoleo', phone: '', name: '' };
  const partner: JwtPayload = { sub: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.ticket.count.mockResolvedValue(0);
    prisma.ticket.create.mockResolvedValue({ id: 'new' });
    const mod = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { writeInApp: jest.fn() } },
        { provide: Msg91Service, useValue: { sendEmail: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TicketsService);
  });

  it('support-admin list attaches raisedBy + outlet (referenced outlets batch-loaded, tenant-pinned)', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      { id: 't1', referenceType: 'OUTLET', referenceId: 'o9', createdBy: isr },
      { id: 't2', referenceType: null, referenceId: null, createdBy: owner },
      { id: 't3', referenceType: null, referenceId: null, createdBy: isr },
    ]);
    prisma.outlet.findMany.mockResolvedValue([{ id: 'o9', outletCode: 'DEO-0900', name: 'Ref Outlet' }]);
    const res = await service.list(clientAdmin, {});
    expect(prisma.outlet.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.outlet.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['o9'] }, clientId: 'deoleo' });
    const [a, b, c] = res.tickets as any[];
    expect(a.raisedBy.label).toBe('Meera Iyer · Territory Sales Officer');
    expect(a.outlet.outletCode).toBe('DEO-0900');
    expect(b.raisedBy.label).toBe('Outlet owner — Ramesh Gupta');
    expect(b.outlet.outletCode).toBe('DEO-0042');
    expect(c.outlet).toBeNull();
    // the support read asks for the submitter's partner + sales identity
    expect(prisma.ticket.findMany.mock.calls[0][0].include.createdBy.select.salesUser).toBeDefined();
  });

  it('field readers keep the old lean createdBy (no partner/sales identity, no raisedBy)', async () => {
    prisma.ticket.findMany.mockResolvedValue([{ id: 't1', createdById: 'u1', createdBy: { id: 'u1', name: 'x' } }]);
    const res = await service.list(partner, {});
    expect(prisma.ticket.findMany.mock.calls[0][0].include.createdBy).toEqual({ select: { id: true, name: true, phone: true } });
    expect(res.tickets[0]).not.toHaveProperty('raisedBy');
  });

  describe('create with outletId', () => {
    const dto = { category: 'POINTS' as never, subject: 's', description: 'd', outletId: 'o1' };

    it('sales: an outlet assigned in their downline is stored as referenceType OUTLET', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'p1' });
      prisma.salesUser.findFirst.mockResolvedValue({ id: 'su-so' });
      prisma.salesUser.findMany.mockResolvedValue([{ id: 'su-so', reportingToId: null }, { id: 'su-isr', reportingToId: 'su-so' }]);
      prisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'as1' });
      await service.create(so, dto);
      const where = prisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
      expect(where.outletId).toBe('o1');
      expect([...where.salesUserId.in].sort()).toEqual(['su-isr', 'su-so']);
      expect(prisma.ticket.create.mock.calls[0][0].data).toMatchObject({ referenceType: 'OUTLET', referenceId: 'o1' });
    });

    it('sales: an outlet outside their downline is refused (no ticket created)', async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'p1' });
      prisma.salesUser.findFirst.mockResolvedValue({ id: 'su-so' });
      prisma.salesUser.findMany.mockResolvedValue([{ id: 'su-so', reportingToId: null }]);
      prisma.salesUserAssignment.findFirst.mockResolvedValue(null);
      await expect(service.create(so, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('a cross-tenant / unknown outlet is refused (lookup pinned to the caller tenant)', async () => {
      prisma.outlet.findFirst.mockResolvedValue(null);
      await expect(service.create(so, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.outlet.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'o1', clientId: 'deoleo' });
    });

    it("partner: only their own outlet", async () => {
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'other' });
      prisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1' });
      await expect(service.create(partner, dto)).rejects.toBeInstanceOf(BadRequestException);
      prisma.outlet.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'p1' });
      await service.create(partner, dto);
      expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
    });

    it('no outletId ("own issue") → no reference stored, no outlet lookup', async () => {
      await service.create(so, { category: 'POINTS' as never, subject: 's', description: 'd' });
      expect(prisma.outlet.findFirst).not.toHaveBeenCalled();
      expect(prisma.ticket.create.mock.calls[0][0].data).not.toHaveProperty('referenceType');
    });
  });
});

describe('ticket-aging Excel: Raised by + Outlet code columns', () => {
  const asOf = new Date();
  const base = {
    ticketNumber: 'TKT-1', subject: 's', category: 'POINTS', priority: 'HIGH', status: 'OPEN',
    createdByName: 'Meera Iyer', createdAt: asOf, updatedAt: asOf, slaBreached: false,
  };

  it('writes the unambiguous raiser and the outlet code (— when unknown)', () => {
    const [a, b] = ticketAgingXlsxRows([
      buildTicketAgingRow({ ...base, raisedBy: 'Meera Iyer · ISR', outletCode: 'DEO-0042' }, asOf),
      buildTicketAgingRow({ ...base, raisedBy: 'Meera Iyer · ISR', outletCode: '' }, asOf),
    ]);
    expect(a['Raised by']).toBe('Meera Iyer · ISR');
    expect(a['Outlet code']).toBe('DEO-0042');
    expect(b['Outlet code']).toBe('—');
    expect(a).not.toHaveProperty('Created By');
  });
});
