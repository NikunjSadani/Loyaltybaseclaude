// Employee Rewards WS2 Wave 7 — unit tests for the rep "Contact support" rail
// (TicketsService.createEmployeeSupport / listEmployeeSupport). Verifies:
//   - the EMPLOYEE-earner tenant gate (a trade tenant → BadRequest) and the own-identity gate
//     (a non-roster caller → Forbidden) BEFORE any ticket is created;
//   - the employee category allow-list (operator-only KYC/PAYOUT/SCHEME are rejected);
//   - a valid submission creates a ticket as the caller (createdById = user.sub, tenant-scoped)
//     and returns the lean own-data shape;
//   - listEmployeeSupport returns ONLY the caller's own tickets, tenant-scoped.
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';

const EMPLOYEE_CLIENT = { loyaltyType: 'EMPLOYEE_REWARDS', features: null };
const TRADE_CLIENT = { loyaltyType: 'TRADE_LOYALTY', features: null };
const SU = { id: 'su-1', accountId: 'acc-1', region: 'WEST', employeeCode: 'EMP001', hierarchyLevel: { code: 'ISR' } };

const user = { sub: 'u-emp1', role: 'SALES_ISR', clientId: 'acme', phone: '', name: '' };

describe('TicketsService — Employee Rewards Wave 7 (contact support)', () => {
  let service: TicketsService;
  const mockPrisma = {
    client: { findUnique: jest.fn() },
    salesUser: { findFirst: jest.fn() },
    ticket: { create: jest.fn(), findMany: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU);
    mockPrisma.ticket.create.mockResolvedValue({
      id: 't1', ticketNumber: 'TKT-ABC', category: 'POINTS', subject: 'S', status: 'OPEN',
      createdAt: new Date('2026-10-13T00:00:00Z'), description: 'D', messages: [],
    });
    mockPrisma.ticket.findMany.mockResolvedValue([
      { id: 't1', ticketNumber: 'TKT-ABC', category: 'POINTS', subject: 'S', status: 'OPEN', createdAt: new Date() },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [TicketsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(TicketsService);
  });

  it('creates a support ticket as the caller and returns the lean own-data shape', async () => {
    const res = await service.createEmployeeSupport(user, {
      category: 'POINTS' as never, subject: 'Points missing', description: 'My Q4 points are missing',
    });
    expect(mockPrisma.ticket.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.ticket.create.mock.calls[0][0].data;
    expect(data.createdById).toBe('u-emp1'); // the caller — never another user
    expect(data.clientId).toBe('acme');
    expect(data.status).toBe('OPEN');
    // Lean response — no internal thread/assignee fields leaked to the rep.
    expect(res.ticket).toEqual({
      id: 't1', ticketNumber: 'TKT-ABC', category: 'POINTS', subject: 'S', status: 'OPEN',
      createdAt: expect.any(Date),
    });
  });

  it('rejects a TRADE tenant before creating anything (earner gate)', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(
      service.createEmployeeSupport(user, { category: 'POINTS' as never, subject: 'S', description: 'D' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.ticket.create).not.toHaveBeenCalled();
  });

  it('rejects a non-roster caller (no SalesUser) → Forbidden, no create', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(
      service.createEmployeeSupport(user, { category: 'POINTS' as never, subject: 'S', description: 'D' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.ticket.create).not.toHaveBeenCalled();
  });

  it('rejects an operator-only category (PAYOUT) for an employee, no create', async () => {
    await expect(
      service.createEmployeeSupport(user, { category: 'PAYOUT' as never, subject: 'S', description: 'D' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.ticket.create).not.toHaveBeenCalled();
  });

  it('rejects an all-whitespace subject/message (no blank-subject ticket), no create', async () => {
    await expect(
      service.createEmployeeSupport(user, { category: 'POINTS' as never, subject: '   ', description: 'real' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createEmployeeSupport(user, { category: 'POINTS' as never, subject: 'real', description: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.ticket.create).not.toHaveBeenCalled();
  });

  it('lists ONLY the caller\'s own tickets, tenant-scoped', async () => {
    const res = await service.listEmployeeSupport(user);
    const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ clientId: 'acme', createdById: 'u-emp1', deletedAt: null });
    expect(res.tickets).toHaveLength(1);
  });

  it('a TRADE tenant cannot list employee support tickets', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.listEmployeeSupport(user)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.ticket.findMany).not.toHaveBeenCalled();
  });
});
