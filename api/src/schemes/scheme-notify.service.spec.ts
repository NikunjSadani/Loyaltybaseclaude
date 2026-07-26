// Unit tests for SchemeNotifyService (Wave-0 scheme broadcasts, D29).
// Covers: recipient resolution (OUTLETS / SALES + up-hierarchy / BOTH + dedup),
// the send-log sentCount/failedCount on a partial send failure, tenant scoping,
// and the pure ancestorSalesUserIds walk.
// Run: npx jest src/schemes/scheme-notify.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { SchemeNotifyService, ancestorSalesUserIds } from './scheme-notify.service';
import { BroadcastDto } from './dto/scheme-notify.dto';

const mockPrisma = {
  scheme: { findFirst: jest.fn() },
  schemeOutlet: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  schemeBroadcast: { create: jest.fn(), findMany: jest.fn() },
};

const mockMsg91 = {
  sendWhatsappTemplate: jest.fn(),
  sendOtp: jest.fn(),
};

const wa = (scope: BroadcastDto['recipientScope'], extra: Partial<BroadcastDto> = {}): BroadcastDto => ({
  channel: 'WHATSAPP',
  templateId: 'scheme_announce',
  recipientScope: scope,
  bodyValues: ['Hello'],
  ...extra,
});

describe('ancestorSalesUserIds (pure)', () => {
  // Tree: ho ← asm ← so ← isr  (isr reports to so reports to asm reports to ho)
  const edges = [
    { id: 'ho', reportingToId: null },
    { id: 'asm', reportingToId: 'ho' },
    { id: 'so', reportingToId: 'asm' },
    { id: 'isr', reportingToId: 'so' },
  ];

  it('returns the tagged user + every ancestor up the chain', () => {
    expect([...ancestorSalesUserIds(['isr'], edges)].sort()).toEqual(['asm', 'ho', 'isr', 'so']);
  });

  it('unions multiple tagged users and dedups shared ancestors', () => {
    expect([...ancestorSalesUserIds(['so', 'asm'], edges)].sort()).toEqual(['asm', 'ho', 'so']);
  });

  it('skips unknown/foreign ids', () => {
    expect([...ancestorSalesUserIds(['ghost'], edges)]).toEqual([]);
  });

  it('is cycle-safe', () => {
    const cyclic = [
      { id: 'a', reportingToId: 'b' },
      { id: 'b', reportingToId: 'a' },
    ];
    expect([...ancestorSalesUserIds(['a'], cyclic)].sort()).toEqual(['a', 'b']);
  });
});

describe('SchemeNotifyService', () => {
  let service: SchemeNotifyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemeNotifyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(SchemeNotifyService);
    mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1' });
    mockPrisma.schemeBroadcast.create.mockImplementation(({ data }) => Promise.resolve({ id: 'b1', ...data }));
  });

  it('throws NotFound when the scheme is not in the caller tenant', async () => {
    mockPrisma.scheme.findFirst.mockResolvedValue(null);
    await expect(service.broadcast('s1', 'deoleo', 'admin1', wa('OUTLETS'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.schemeBroadcast.create).not.toHaveBeenCalled();
  });

  describe('OUTLETS scope', () => {
    it('resolves matched-outlet/owner phones, prefers owner phone, and skips standalone rows', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        // matched, owner phone present → owner wins over outlet phone
        { matchedOutletId: 'o1', matchedPartner: { phone: '9990000001' }, matchedOutlet: { phone: '8880000001', zone: 'W', programName: null, programCategory: null, state: null, outletTypeId: null } },
        // matched, no owner → outlet phone
        { matchedOutletId: 'o2', matchedPartner: null, matchedOutlet: { phone: '9990000002', zone: 'W', programName: null, programCategory: null, state: null, outletTypeId: null } },
        // standalone → excluded (no matchedOutlet)
        { matchedOutletId: null, matchedPartner: null, matchedOutlet: null },
      ]);

      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('OUTLETS'));

      const sentTo = mockMsg91.sendWhatsappTemplate.mock.calls.map((c) => c[0]).sort();
      expect(sentTo).toEqual(['9990000001', '9990000002']);
      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith('9990000001', 'scheme_announce', ['Hello']);
      expect(res.sentCount).toBe(2);
      expect(res.failedCount).toBe(0);
      // SALES paths untouched.
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('narrows recipients by an outlet filter (zone)', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { matchedOutletId: 'o1', matchedPartner: { phone: '9990000001' }, matchedOutlet: { phone: null, zone: 'North', programName: null, programCategory: null, state: null, outletTypeId: null } },
        { matchedOutletId: 'o2', matchedPartner: { phone: '9990000002' }, matchedOutlet: { phone: null, zone: 'South', programName: null, programCategory: null, state: null, outletTypeId: null } },
      ]);

      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('OUTLETS', { recipientFilter: { zones: ['North'] } }));

      const sentTo = mockMsg91.sendWhatsappTemplate.mock.calls.map((c) => c[0]);
      expect(sentTo).toEqual(['9990000001']);
      expect(res.sentCount).toBe(1);
    });
  });

  describe('SALES scope', () => {
    it('resolves tagged employees + up-hierarchy → User phones', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([{ taggedSalesUserId: 'isr' }]);
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'isr', reportingToId: 'so', userId: 'u_isr' },
        { id: 'so', reportingToId: null, userId: 'u_so' },
        { id: 'other', reportingToId: null, userId: 'u_other' },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([{ phone: '9900000041' }, { phone: '9900000002' }]);

      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('SALES'));

      // Only isr + its ancestor so → their userIds queried (NOT 'other').
      const userWhere = mockPrisma.user.findMany.mock.calls[0][0].where;
      expect(userWhere.id.in.sort()).toEqual(['u_isr', 'u_so']);
      expect(res.sentCount).toBe(2);
    });

    it('returns zero recipients (still logs) when no roster row is tagged', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([]);
      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('SALES'));
      expect(res.recipientCount).toBe(0);
      expect(res.sentCount).toBe(0);
      expect(mockPrisma.schemeBroadcast.create).toHaveBeenCalled();
    });

    it('walks PAST a soft-deleted mid-chain manager to the next active ancestor (B-LOW-2)', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([{ taggedSalesUserId: 'isr' }]);
      // Chain: isr → so (SOFT-DELETED) → asm. The walk must NOT stop at `so`; `asm` is
      // notified, while the deleted `so` is excluded from the final recipient set.
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'isr', reportingToId: 'so', userId: 'u_isr', deletedAt: null },
        { id: 'so', reportingToId: 'asm', userId: 'u_so', deletedAt: new Date() },
        { id: 'asm', reportingToId: null, userId: 'u_asm', deletedAt: null },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([{ phone: '9900000041' }, { phone: '9900000003' }]);

      await service.broadcast('s1', 'deoleo', 'admin1', wa('SALES'));

      // edges loaded WITHOUT a deletedAt filter (so the walk can traverse the deleted node).
      expect(mockPrisma.salesUser.findMany.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
      // active isr + asm queried; the deleted `so` excluded — but the chain was NOT truncated.
      const userWhere = mockPrisma.user.findMany.mock.calls[0][0].where;
      expect(userWhere.id.in.sort()).toEqual(['u_asm', 'u_isr']);
    });
  });

  describe('BOTH scope', () => {
    it('unions outlet + sales phones and dedups a phone shared across scopes', async () => {
      // Outlet resolution query (first schemeOutlet.findMany) → shared phone 9900000041.
      // Sales resolution query (second) → tagged isr.
      mockPrisma.schemeOutlet.findMany
        .mockResolvedValueOnce([
          { matchedOutletId: 'o1', matchedPartner: { phone: '9900000041' }, matchedOutlet: { phone: null, zone: null, programName: null, programCategory: null, state: null, outletTypeId: null } },
        ])
        .mockResolvedValueOnce([{ taggedSalesUserId: 'isr' }]);
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'isr', reportingToId: null, userId: 'u_isr' }]);
      mockPrisma.user.findMany.mockResolvedValue([{ phone: '9900000041' }]); // same phone as the outlet owner

      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('BOTH'));

      expect(res.recipientCount).toBe(1); // deduped
      expect(res.sentCount).toBe(1);
    });
  });

  describe('send-log on partial failure', () => {
    it('counts sent vs failed and NEVER throws when a single send fails', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { matchedOutletId: 'o1', matchedPartner: { phone: '9990000001' }, matchedOutlet: { phone: null, zone: null, programName: null, programCategory: null, state: null, outletTypeId: null } },
        { matchedOutletId: 'o2', matchedPartner: { phone: '9990000002' }, matchedOutlet: { phone: null, zone: null, programName: null, programCategory: null, state: null, outletTypeId: null } },
        { matchedOutletId: 'o3', matchedPartner: { phone: '9990000003' }, matchedOutlet: { phone: null, zone: null, programName: null, programCategory: null, state: null, outletTypeId: null } },
      ]);
      mockMsg91.sendWhatsappTemplate
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('MSG91 down'))
        .mockResolvedValueOnce(undefined);

      const res = await service.broadcast('s1', 'deoleo', 'admin1', wa('OUTLETS'));

      expect(res.sentCount).toBe(2);
      expect(res.failedCount).toBe(1);
      const logged = mockPrisma.schemeBroadcast.create.mock.calls[0][0].data;
      expect(logged).toMatchObject({
        clientId: 'deoleo',
        schemeId: 's1',
        channel: 'WHATSAPP',
        templateId: 'scheme_announce',
        recipientScope: 'OUTLETS',
        sentCount: 2,
        failedCount: 1,
        sentByUserId: 'admin1',
      });
    });
  });

  describe('SMS channel', () => {
    it('routes SMS via sendOtp carrying bodyValues[0] as the single template variable', async () => {
      mockPrisma.schemeOutlet.findMany.mockResolvedValue([
        { matchedOutletId: 'o1', matchedPartner: { phone: '9990000001' }, matchedOutlet: { phone: null, zone: null, programName: null, programCategory: null, state: null, outletTypeId: null } },
      ]);
      await service.broadcast('s1', 'deoleo', 'admin1', { channel: 'SMS', templateId: 'sms_tpl', recipientScope: 'OUTLETS', bodyValues: ['CODE123'] });
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9990000001', 'CODE123', 'SMS', 'sms_tpl');
      expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });
  });

  describe('listBroadcasts', () => {
    it('returns tenant-scoped history newest-first', async () => {
      mockPrisma.schemeBroadcast.findMany.mockResolvedValue([{ id: 'b2' }, { id: 'b1' }]);
      const res = await service.listBroadcasts('s1', 'deoleo');
      expect(res.broadcasts).toHaveLength(2);
      expect(mockPrisma.schemeBroadcast.findMany).toHaveBeenCalledWith({
        where: { schemeId: 's1', clientId: 'deoleo' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('throws NotFound for a cross-tenant scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.listBroadcasts('s1', 'other')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('stores recipientFilter as JsonNull when absent', async () => {
    mockPrisma.schemeOutlet.findMany.mockResolvedValue([]);
    await service.broadcast('s1', 'deoleo', 'admin1', wa('OUTLETS'));
    const data = mockPrisma.schemeBroadcast.create.mock.calls[0][0].data;
    expect(data.recipientFilter).toBe(Prisma.JsonNull);
  });
});
