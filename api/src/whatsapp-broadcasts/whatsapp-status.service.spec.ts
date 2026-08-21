import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WhatsappStatusService } from './whatsapp-status.service';

const mockPrisma = {
  whatsappBroadcastRecipient: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
  },
  whatsappBroadcast: { update: jest.fn() },
};

const mockMsg91 = { getWhatsappStatusByRequestId: jest.fn() };

describe('WhatsappStatusService', () => {
  let service: WhatsappStatusService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappStatusService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(WhatsappStatusService);
  });

  describe('parseEvents (tolerant of MSG91 shapes)', () => {
    it('parses a top-level array', () => {
      const events = service.parseEvents([
        { crqid: 'r1', status: 'Delivered', timestamp: '1700000000' },
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ crqid: 'r1', status: 'delivered' });
    });
    it('parses a { data: [...] } envelope + requestId fallback', () => {
      const events = service.parseEvents({ data: [{ requestId: 'req9', status: 'READ' }] });
      expect(events[0]).toMatchObject({ requestId: 'req9', status: 'read' });
    });
    it('skips events with no status and never throws on junk', () => {
      expect(service.parseEvents(null)).toEqual([]);
      expect(service.parseEvents({ foo: 'bar' })).toEqual([]);
    });
  });

  describe('handleWebhook — DELIVERED transition + counter roll (idempotent)', () => {
    it('rolls deliveredCount ONCE on the first event, no-ops on a retry', async () => {
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValue({ id: 'r1', broadcastId: 'b1' });
      // First delivery: the guarded updateMany flips 1 row; retry flips 0.
      mockPrisma.whatsappBroadcastRecipient.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const first = await service.handleWebhook([{ crqid: 'r1', status: 'delivered' }]);
      expect(first).toEqual({ processed: 1, updated: 1 });
      expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { deliveredCount: { increment: 1 } },
      });

      mockPrisma.whatsappBroadcast.update.mockClear();
      const retry = await service.handleWebhook([{ crqid: 'r1', status: 'delivered' }]);
      expect(retry).toEqual({ processed: 1, updated: 0 });
      expect(mockPrisma.whatsappBroadcast.update).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhook — READ implies delivered', () => {
    it('rolls read + delivered (via separate atomic guards) when not yet delivered', async () => {
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValueOnce({
        id: 'r2',
        broadcastId: 'b1',
      }); // applyEvent resolve (markRead no longer pre-reads deliveredAt)
      // Both guarded updates (READ transition + deliveredAt claim) flip a row.
      mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.handleWebhook([{ crqid: 'r2', status: 'read' }]);
      expect(res.updated).toBe(1);
      // read counter rolls…
      expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { readCount: { increment: 1 } },
      });
      // …and the delivered counter rolls once via the atomic deliveredAt guard.
      expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { deliveredCount: { increment: 1 } },
      });
    });

    it('does NOT double-roll delivered when the row was already delivered', async () => {
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValueOnce({
        id: 'r3',
        broadcastId: 'b1',
      });
      // READ guard flips (count 1); deliveredAt guard finds it already set (count 0).
      mockPrisma.whatsappBroadcastRecipient.updateMany
        .mockResolvedValueOnce({ count: 1 }) // READ transition
        .mockResolvedValueOnce({ count: 0 }); // deliveredAt already set

      const res = await service.handleWebhook([{ crqid: 'r3', status: 'read' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { readCount: { increment: 1 } },
      });
      expect(mockPrisma.whatsappBroadcast.update).not.toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { deliveredCount: { increment: 1 } },
      });
    });
  });

  describe('markFailed — counter integrity on a SENT→FAILED downgrade', () => {
    it('decrements sentCount when a previously-SENT row fails (no sentAt overwrite)', async () => {
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValueOnce({
        id: 'r4',
        broadcastId: 'b1',
      }); // applyEvent resolve
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValueOnce({
        status: 'SENT',
      }); // markFailed prior-status read
      mockPrisma.whatsappBroadcastRecipient.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.handleWebhook([{ crqid: 'r4', status: 'failed', reason: 'x' }]);
      expect(res.updated).toBe(1);
      // FAILED update must NOT stamp sentAt.
      const failCall = mockPrisma.whatsappBroadcastRecipient.updateMany.mock.calls.find(
        (c: any) => c[0]?.data?.status === 'FAILED',
      );
      expect(failCall[0].data).not.toHaveProperty('sentAt');
      // failedCount up, sentCount down (kept non-divergent).
      expect(mockPrisma.whatsappBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { failedCount: { increment: 1 }, sentCount: { decrement: 1 } },
      });
    });
  });

  describe('handleWebhook — unknown correlation is ignored', () => {
    it('does nothing when neither crqid nor requestId resolves a row', async () => {
      mockPrisma.whatsappBroadcastRecipient.findUnique.mockResolvedValue(null);
      mockPrisma.whatsappBroadcastRecipient.findFirst.mockResolvedValue(null);
      const res = await service.handleWebhook([{ requestId: 'ghost', status: 'delivered' }]);
      expect(res).toEqual({ processed: 1, updated: 0 });
      expect(mockPrisma.whatsappBroadcast.update).not.toHaveBeenCalled();
    });
  });
});
