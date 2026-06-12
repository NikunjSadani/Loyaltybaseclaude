// TDD — NotificationsService
// RED: all tests fail until notifications.service.ts is implemented.
//
// Covers:
//   N1: enqueue creates a QUEUED notification record
//   N2: processQueue sends via MSG91 (SMS) and marks record SENT
//   N3: processQueue marks record FAILED if provider call throws
//   N4: processQueue skips records that have exceeded maxRetries

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService }       from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService }        from '../prisma/prisma.service';

// ── Shared mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  notificationQueue:       { create: jest.fn(), findMany: jest.fn(), update: jest.fn(),
                             count: jest.fn() },
  notificationDeliveryLog: { create: jest.fn() },
  notificationTemplate:    { findMany: jest.fn(), findFirst: jest.fn() },
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const vals: Record<string, string> = {
      MSG91_AUTH_KEY:      'test-auth-key',
      MSG91_SMS_TEMPLATE_ID: 'tpl_sms_123',   // general SMS — NOT the OTP template
    };
    return vals[key];
  }),
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const queuedRecord = {
  id: 'nq_1', userId: 'user_1', channel: 'SMS',
  status: 'QUEUED', body: 'Your OTP is 123456',
  recipientPhone: '9876543210',
  retryCount: 0, maxRetries: 3,
  createdAt: new Date(),
};

// ─────────────────────────────────────────────────────────────────────────────

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService,   useValue: mockPrisma },
        { provide: ConfigService,   useValue: mockConfig },
      ],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
    jest.clearAllMocks();
    // Default: global.fetch resolves to ok
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ type: 'success' }) } as any);
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Enqueue ───────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('N1: creates a QUEUED notification record', async () => {
      mockPrisma.notificationQueue.create.mockResolvedValue(queuedRecord);

      const result = await service.enqueue({
        userId:         'user_1',
        channel:        'SMS',
        body:           'Your OTP is 123456',
        recipientPhone: '9876543210',
      });

      expect(result.status).toBe('QUEUED');
      expect(mockPrisma.notificationQueue.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'QUEUED', channel: 'SMS' }),
        }),
      );
    });
  });

  // ── Process queue ─────────────────────────────────────────────────────────

  describe('processQueue', () => {
    it('N2: sends via MSG91 and marks record SENT on success', async () => {
      mockPrisma.notificationQueue.findMany.mockResolvedValue([queuedRecord]);
      mockPrisma.notificationQueue.update.mockResolvedValue({
        ...queuedRecord, status: 'SENT',
      });
      mockPrisma.notificationDeliveryLog.create.mockResolvedValue({});

      await service.processQueue();

      expect(global.fetch).toHaveBeenCalled();
      expect(mockPrisma.notificationQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'nq_1' },
          data:  expect.objectContaining({ status: 'SENT' }),
        }),
      );
    });

    it('N3: marks record FAILED when provider call throws', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
      mockPrisma.notificationQueue.findMany.mockResolvedValue([queuedRecord]);
      mockPrisma.notificationQueue.update.mockResolvedValue({
        ...queuedRecord, status: 'FAILED', retryCount: 1,
      });
      mockPrisma.notificationDeliveryLog.create.mockResolvedValue({});

      await service.processQueue();

      expect(mockPrisma.notificationQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ retryCount: { increment: 1 } }),
        }),
      );
    });

    it('N4: skips records that have exceeded maxRetries', async () => {
      const exhaustedRecord = { ...queuedRecord, retryCount: 3, maxRetries: 3 };
      mockPrisma.notificationQueue.findMany.mockResolvedValue([exhaustedRecord]);
      mockPrisma.notificationQueue.update.mockResolvedValue({
        ...exhaustedRecord, status: 'FAILED',
      });
      mockPrisma.notificationDeliveryLog.create.mockResolvedValue({});

      await service.processQueue();

      // fetch should NOT be called for exhausted records
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
