// Unit tests for the Wave 4 delivery-status REPORTING surface.
// Verifies (isolation-critical): CLIENT_ADMIN is force-scoped to their own clientId; a smuggled
// clientId on the query is ignored (scope comes only from the JWT); an un-assumed GIFSY_ADMIN is
// platform-wide (no clientId filter) while an assumed operator is pinned. Also: summary funnel math,
// OTP indicative flag, list pagination + shape, export builds a StreamableFile, and the retention
// prune deletes ONLY >90d rows and only when its env flag is on.
// Run: npx jest src/notifications/notification-delivery-report.service.spec.ts

import { ForbiddenException, StreamableFile } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MessageDeliveryStatusService } from './message-delivery-status.service';
import { NotificationDeliveryReportService } from './notification-delivery-report.service';
import { NotificationDeliveryRetentionWorker } from './notification-delivery-retention.worker';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';

// M3: mock the workbook builder so export tests can inspect the exact rows handed to it (a real
// xlsx buffer is opaque). Returns a Buffer so `new StreamableFile(...)` still succeeds.
jest.mock('../common/xlsx', () => ({
  buildXlsx: jest.fn(() => Buffer.from('xlsx')),
}));

const CLIENT_ADMIN: JwtPayload = {
  sub: 'u1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};
const OPERATOR_UNASSUMED: JwtPayload = {
  sub: 'op1',
  role: 'GIFSY_ADMIN',
  clientId: 'gifsy',
  phone: '',
  name: '',
};
const OPERATOR_ASSUMED: JwtPayload = {
  sub: 'op1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
  assumed: true,
};

const mockPrisma = {
  messageDeliveryReceipt: {
    groupBy: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockStatus = { getOtpDeliveryStats: jest.fn() };

describe('NotificationDeliveryReportService', () => {
  let service: NotificationDeliveryReportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default status buckets keyed by the channel in the where.
    mockPrisma.messageDeliveryReceipt.groupBy.mockImplementation(
      async ({ where }: { where: { channel?: string } }) => {
        if (where.channel === 'SMS') {
          return [
            { status: 'QUEUED', _count: { _all: 3 } },
            { status: 'SENT', _count: { _all: 2 } },
            { status: 'DELIVERED', _count: { _all: 5 } },
            { status: 'FAILED', _count: { _all: 1 } },
          ];
        }
        if (where.channel === 'WHATSAPP') {
          return [
            { status: 'SENT', _count: { _all: 1 } },
            { status: 'DELIVERED', _count: { _all: 2 } },
            { status: 'READ', _count: { _all: 4 } },
          ];
        }
        return [];
      },
    );
    // M1: `count` backs the DISPATCHED (sentAt != null) count per channel. Default it to the
    // dispatched total that matches the status buckets above (SMS SENT2+DELIVERED5=7; WA
    // SENT1+DELIVERED2+READ4=7), so the funnel's `sent` reflects "was dispatched".
    mockPrisma.messageDeliveryReceipt.count.mockImplementation(
      async ({ where }: { where?: { channel?: string } }) => {
        if (where?.channel === 'SMS') return 7;
        if (where?.channel === 'WHATSAPP') return 7;
        return 0;
      },
    );
    mockStatus.getOtpDeliveryStats.mockResolvedValue({
      total: 12,
      delivered: 9,
      failed: 1,
      sent: 2,
      pending: 0,
      deliveryRate: 0.9,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryReportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MessageDeliveryStatusService, useValue: mockStatus },
      ],
    }).compile();
    service = module.get(NotificationDeliveryReportService);
  });

  // ── SCOPING (isolation-critical) ──────────────────────────────────────────

  describe('tenant scoping (D4)', () => {
    it('CLIENT_ADMIN: every query is pinned to the token clientId', async () => {
      await service.summary(CLIENT_ADMIN, {});
      for (const call of mockPrisma.messageDeliveryReceipt.groupBy.mock.calls) {
        expect(call[0].where.clientId).toBe('deoleo');
      }
      // OTP is tenant-scoped + flagged indicative.
      expect(mockStatus.getOtpDeliveryStats).toHaveBeenCalledWith({ clientId: 'deoleo' });
    });

    it('CLIENT_ADMIN: a smuggled clientId on the query is IGNORED (scope is JWT-only)', async () => {
      // The DTO carries no clientId (whitelist strips it), but prove the service never reads one.
      await service.summary(CLIENT_ADMIN, { clientId: 'attacker-tenant' } as never);
      for (const call of mockPrisma.messageDeliveryReceipt.groupBy.mock.calls) {
        expect(call[0].where.clientId).toBe('deoleo');
        expect(call[0].where.clientId).not.toBe('attacker-tenant');
      }
      const listWhere = await captureListWhere(() =>
        service.list(CLIENT_ADMIN, { clientId: 'attacker-tenant' } as never),
      );
      expect(listWhere.clientId).toBe('deoleo');
    });

    it('GIFSY_ADMIN un-assumed: platform-wide — NO clientId filter', async () => {
      await service.summary(OPERATOR_UNASSUMED, {});
      for (const call of mockPrisma.messageDeliveryReceipt.groupBy.mock.calls) {
        expect(call[0].where.clientId).toBeUndefined();
      }
      expect(mockStatus.getOtpDeliveryStats).toHaveBeenCalledWith(undefined);
    });

    it('GIFSY_ADMIN assumed: pinned to the assumed tenant', async () => {
      await service.summary(OPERATOR_ASSUMED, {});
      for (const call of mockPrisma.messageDeliveryReceipt.groupBy.mock.calls) {
        expect(call[0].where.clientId).toBe('deoleo');
      }
      expect(mockStatus.getOtpDeliveryStats).toHaveBeenCalledWith({ clientId: 'deoleo' });
    });
  });

  // ── SUMMARY ───────────────────────────────────────────────────────────────

  describe('summary funnel', () => {
    it('computes cumulative SMS + WhatsApp funnels + terminal delivery rate', async () => {
      const res = await service.summary(OPERATOR_UNASSUMED, {});
      // SMS: QUEUED3 SENT2 DELIVERED5 FAILED1 → delivered=5, sent=7, failed=1, pending=3, rate 5/6.
      expect(res.sms).toEqual({
        sent: 7,
        delivered: 5,
        failed: 1,
        pending: 3,
        deliveryRate: 5 / 6,
      });
      // WA: SENT1 DELIVERED2 READ4 → read=4, delivered=6, sent=7, failed=0, pending=0, rate 1.
      expect(res.whatsapp).toEqual({
        sent: 7,
        delivered: 6,
        read: 4,
        failed: 0,
        pending: 0,
        deliveryRate: 1,
      });
    });

    it('M1: Sent = DISPATCHED rows (sentAt != null), so it never understates delivered + delivery-failures', async () => {
      // 90 DELIVERED + 10 FAILED that were dispatched then failed delivery (they carry sentAt but sit
      // in the FAILED bucket) → all 100 were dispatched. The OLD `SENT + delivered` would have read
      // sent=90 (< delivered 90 + failed 10); the fix reads the true dispatched count = 100.
      mockPrisma.messageDeliveryReceipt.groupBy.mockImplementation(
        async ({ where }: { where: { channel?: string } }) => {
          if (where.channel === 'SMS') {
            return [
              { status: 'DELIVERED', _count: { _all: 90 } },
              { status: 'FAILED', _count: { _all: 10 } },
            ];
          }
          return [];
        },
      );
      mockPrisma.messageDeliveryReceipt.count.mockImplementation(
        async ({ where }: { where?: { channel?: string } }) =>
          where?.channel === 'SMS' ? 100 : 0,
      );

      const res = await service.summary(OPERATOR_UNASSUMED, { channel: 'SMS' });
      expect(res.sms).toEqual({
        sent: 100,
        delivered: 90,
        failed: 10,
        pending: 0,
        deliveryRate: 90 / 100,
      });
      // The dispatched count is a `sentAt: { not: null }` count query (not a status bucket).
      const countWhere =
        mockPrisma.messageDeliveryReceipt.count.mock.calls[0][0].where;
      expect(countWhere.sentAt).toEqual({ not: null });
      expect(countWhere.channel).toBe('SMS');
    });

    it('OTP tile: authoritative (not indicative) for the platform operator, with total + pending surfaced (D2)', async () => {
      const res = await service.summary(OPERATOR_UNASSUMED, {});
      expect(res.otp).toEqual({
        total: 12,
        sent: 2,
        delivered: 9,
        failed: 1,
        pending: 0,
        deliveryRate: 0.9,
        indicative: false,
      });
    });

    it('OTP tile: indicative for a tenant-scoped caller', async () => {
      const res = await service.summary(CLIENT_ADMIN, {});
      expect(res.otp.indicative).toBe(true);
    });

    it('channel filter restricts to one channel (the other funnel stays zeroed)', async () => {
      const res = await service.summary(OPERATOR_UNASSUMED, { channel: 'SMS' });
      expect(res.sms.sent).toBe(7);
      expect(res.whatsapp).toEqual({
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        pending: 0,
        deliveryRate: null,
      });
      // WHATSAPP groupBy was never issued.
      const channels = mockPrisma.messageDeliveryReceipt.groupBy.mock.calls.map(
        (c) => c[0].where.channel,
      );
      expect(channels).not.toContain('WHATSAPP');
    });

    it('applies the from/to date window to createdAt', async () => {
      await service.summary(OPERATOR_UNASSUMED, {
        from: '2026-01-01',
        to: '2026-02-01',
      });
      const where = mockPrisma.messageDeliveryReceipt.groupBy.mock.calls[0][0].where;
      // Date-only inputs are IST calendar days: from → start of that IST day; to → INCLUSIVE of the
      // whole IST day, expressed as an exclusive lt at the start of the NEXT IST day (so "To=today"
      // captures all of today's messages). No lte.
      expect(where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00+05:30'));
      expect(where.createdAt.lt).toEqual(new Date('2026-02-02T00:00:00+05:30'));
      expect(where.createdAt.lte).toBeUndefined();
    });
  });

  // ── LIST ────────────────────────────────────────────────────────────────

  describe('list', () => {
    beforeEach(() => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue([
        {
          id: 'r1',
          channel: 'SMS',
          eventKey: 'ORDER_APPROVED',
          recipientPhone: '9830011252',
          status: 'DELIVERED',
          sentAt: new Date('2026-02-01T10:00:00.000Z'),
          deliveredAt: new Date('2026-02-01T10:00:05.000Z'),
          readAt: null,
          failureReason: null,
          createdAt: new Date('2026-02-01T09:59:59.000Z'),
        },
      ]);
      mockPrisma.messageDeliveryReceipt.count.mockResolvedValue(41);
    });

    it('returns { items, total, page, pageSize } with ISO-string timestamps', async () => {
      const res = await service.list(CLIENT_ADMIN, { page: 2, pageSize: 20 });
      expect(res.total).toBe(41);
      expect(res.page).toBe(2);
      expect(res.pageSize).toBe(20);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toEqual({
        id: 'r1',
        channel: 'SMS',
        eventKey: 'ORDER_APPROVED',
        recipientPhone: '9830011252',
        status: 'DELIVERED',
        sentAt: '2026-02-01T10:00:00.000Z',
        deliveredAt: '2026-02-01T10:00:05.000Z',
        readAt: null,
        failureReason: null,
        createdAt: '2026-02-01T09:59:59.000Z',
      });
    });

    it('paginates via skip/take and orders newest-first, scoped to the tenant', async () => {
      await service.list(CLIENT_ADMIN, { page: 3, pageSize: 10 });
      const arg = mockPrisma.messageDeliveryReceipt.findMany.mock.calls[0][0];
      expect(arg.skip).toBe(20);
      expect(arg.take).toBe(10);
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
      expect(arg.where.clientId).toBe('deoleo');
    });

    it('defaults to page 1 / pageSize 50 when omitted', async () => {
      const res = await service.list(CLIENT_ADMIN, {});
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(50);
      const arg = mockPrisma.messageDeliveryReceipt.findMany.mock.calls[0][0];
      expect(arg.skip).toBe(0);
      expect(arg.take).toBe(50);
    });
  });

  // ── EXPORT ─────────────────────────────────────────────────────────────

  describe('export', () => {
    it('builds a StreamableFile (xlsx) scoped to the tenant', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue([
        {
          id: 'r1',
          channel: 'WHATSAPP',
          eventKey: 'REWARD_CREDITED',
          recipientPhone: '6289864191',
          status: 'READ',
          sentAt: new Date('2026-02-01T10:00:00.000Z'),
          deliveredAt: new Date('2026-02-01T10:00:05.000Z'),
          readAt: new Date('2026-02-01T10:01:00.000Z'),
          failureReason: null,
          createdAt: new Date('2026-02-01T09:59:59.000Z'),
        },
      ]);
      const res = await service.export(CLIENT_ADMIN, {});
      expect(res).toBeInstanceOf(StreamableFile);
      const where = mockPrisma.messageDeliveryReceipt.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
    });

    it('still builds a (header-only) workbook when there are no rows', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue([]);
      const res = await service.export(OPERATOR_UNASSUMED, {});
      expect(res).toBeInstanceOf(StreamableFile);
    });

    it('M3: appends a truncation-notice row when the export hits the row cap', async () => {
      const cap = (
        NotificationDeliveryReportService as unknown as { MAX_EXPORT_ROWS: number }
      ).MAX_EXPORT_ROWS;
      // findMany returns exactly the cap → the result was (potentially) clipped.
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue(
        Array.from({ length: cap }, () => ({})),
      );
      await service.export(OPERATOR_UNASSUMED, {});

      const sheets = (buildXlsx as jest.Mock).mock.calls[0][0];
      const rows = sheets[0].rows as Array<{ Channel: string }>;
      // cap data rows + 1 notice row.
      expect(rows).toHaveLength(cap + 1);
      expect(rows[rows.length - 1].Channel).toContain('truncated');
    });

    it('M3: no truncation notice when the result is below the cap', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue([
        {
          id: 'r1',
          channel: 'SMS',
          eventKey: null,
          recipientPhone: null,
          status: 'SENT',
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failureReason: null,
          createdAt: null,
        },
      ]);
      await service.export(OPERATOR_UNASSUMED, {});

      const sheets = (buildXlsx as jest.Mock).mock.calls[0][0];
      const rows = sheets[0].rows as Array<{ Channel: string }>;
      expect(rows).toHaveLength(1);
      expect(rows.some((r) => r.Channel.includes('truncated'))).toBe(false);
    });
  });

  // ── INFO-2 (isolation defence-in-depth) ────────────────────────────────────

  describe('scope hardening (INFO-2)', () => {
    const EMPTY_SCOPE_ADMIN: JwtPayload = {
      sub: 'x',
      role: 'CLIENT_ADMIN',
      clientId: '',
      phone: '',
      name: '',
    };

    it('a non-platform-wide caller with a falsy scope is REFUSED (never reads unscoped)', async () => {
      await expect(service.summary(EMPTY_SCOPE_ADMIN, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.list(EMPTY_SCOPE_ADMIN, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.export(EMPTY_SCOPE_ADMIN, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Fail-closed BEFORE any query is issued — no unscoped read ever reaches the DB.
      expect(mockPrisma.messageDeliveryReceipt.groupBy).not.toHaveBeenCalled();
      expect(mockPrisma.messageDeliveryReceipt.findMany).not.toHaveBeenCalled();
      expect(mockStatus.getOtpDeliveryStats).not.toHaveBeenCalled();
    });
  });

  // helper: run a list() call and return the where it issued.
  async function captureListWhere(
    run: () => Promise<unknown>,
  ): Promise<{ clientId?: string }> {
    mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValue([]);
    mockPrisma.messageDeliveryReceipt.count.mockResolvedValue(0);
    await run();
    const calls = mockPrisma.messageDeliveryReceipt.findMany.mock.calls;
    return calls[calls.length - 1][0].where;
  }
});

describe('NotificationDeliveryRetentionWorker (90-day prune)', () => {
  const mp = {
    messageDeliveryReceipt: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  let worker: NotificationDeliveryRetentionWorker;

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.NOTIFICATIONS_RETENTION_ENABLED;
    delete process.env.NOTIFICATIONS_RETENTION_DAYS;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryRetentionWorker,
        { provide: PrismaService, useValue: mp },
      ],
    }).compile();
    worker = module.get(NotificationDeliveryRetentionWorker);
  });

  afterAll(() => {
    delete process.env.NOTIFICATIONS_RETENTION_ENABLED;
    delete process.env.NOTIFICATIONS_RETENTION_DAYS;
  });

  it('is DORMANT: prune() no-ops (no delete) when the env flag is unset', async () => {
    const res = await worker.prune();
    expect(res).toEqual({ deleted: 0 });
    expect(mp.messageDeliveryReceipt.findMany).not.toHaveBeenCalled();
    expect(mp.messageDeliveryReceipt.deleteMany).not.toHaveBeenCalled();
  });

  it('prune() runs when the env flag is "true"', async () => {
    process.env.NOTIFICATIONS_RETENTION_ENABLED = 'true';
    mp.messageDeliveryReceipt.findMany.mockResolvedValueOnce([]);
    const res = await worker.prune();
    expect(res).toEqual({ deleted: 0 });
    expect(mp.messageDeliveryReceipt.findMany).toHaveBeenCalledTimes(1);
  });

  it('deletes ONLY rows older than the 90-day cutoff, in batches', async () => {
    mp.messageDeliveryReceipt.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` })),
      )
      .mockResolvedValueOnce([{ id: 'b0' }]);
    mp.messageDeliveryReceipt.deleteMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });

    const before = Date.now();
    const res = await worker.runPrune();
    const after = Date.now();

    expect(res.deleted).toBe(1001);
    // Selection is strictly createdAt < (now - 90d) — nothing newer is ever touched.
    const where = mp.messageDeliveryReceipt.findMany.mock.calls[0][0].where;
    const cutoff = (where.createdAt.lt as Date).getTime();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - ninetyDays - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - ninetyDays + 1000);
    // Two batches deleted; each deleteMany keyed only on the selected ids.
    expect(mp.messageDeliveryReceipt.deleteMany).toHaveBeenCalledTimes(2);
    expect(mp.messageDeliveryReceipt.deleteMany.mock.calls[1][0].where.id.in).toEqual(['b0']);
  });

  it('honors NOTIFICATIONS_RETENTION_DAYS override', async () => {
    process.env.NOTIFICATIONS_RETENTION_DAYS = '30';
    mp.messageDeliveryReceipt.findMany.mockResolvedValueOnce([]);
    const before = Date.now();
    await worker.runPrune();
    const where = mp.messageDeliveryReceipt.findMany.mock.calls[0][0].where;
    const cutoff = (where.createdAt.lt as Date).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 1000);
    expect(cutoff).toBeLessThanOrEqual(before - thirtyDays + 1000);
  });

  it('never throws on a DB error (missing table / transient) — swallows + logs', async () => {
    mp.messageDeliveryReceipt.findMany.mockRejectedValueOnce(new Error('no such table'));
    await expect(worker.runPrune()).resolves.toEqual({ deleted: 0 });
  });
});
