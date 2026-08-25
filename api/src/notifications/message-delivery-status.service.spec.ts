// Unit tests for MessageDeliveryStatusService — the shared, channel-agnostic delivery-status
// ingestion (D3). Verifies: tolerant parse (array / {data:[]} / single / crqid+requestId aliases /
// junk), crqid-then-requestId correlation, each guarded idempotent transition (SENT→DELIVERED,
// →READ implies delivered, →FAILED), duplicate-callback no-op, no-downgrade of a terminal row, and
// unknown-crqid ignore.
// Run: npx jest src/notifications/message-delivery-status.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from './msg91.service';
import { MessageDeliveryStatusService } from './message-delivery-status.service';

const mockPrisma = {
  messageDeliveryReceipt: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  // Wave 3 (light D1) — OTP fallback correlation + aggregate.
  otpCode: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    groupBy: jest.fn(),
  },
};

const mockMsg91 = { getSmsStatusByRequestId: jest.fn() };

describe('MessageDeliveryStatusService', () => {
  let service: MessageDeliveryStatusService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: providerResponse merge reads find a row with no prior response.
    mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValue({ providerResponse: null });
    mockPrisma.messageDeliveryReceipt.update.mockResolvedValue({});
    // Default: no OtpCode matches (the OTP fallback is only exercised in its own tests).
    mockPrisma.otpCode.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageDeliveryStatusService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(MessageDeliveryStatusService);
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
    it('parses a single object and reads crqid/requestId aliases', () => {
      const a = service.parseEvents({ crqId: 'c1', status: 'failed', description: 'DND' });
      expect(a[0]).toMatchObject({ crqid: 'c1', status: 'failed', reason: 'DND' });
      const b = service.parseEvents({ cref: 'c2', request_id: 'q2', status: 'delivered' });
      expect(b[0]).toMatchObject({ crqid: 'c2', requestId: 'q2', status: 'delivered' });
    });
    it('skips events with no status and never throws on junk', () => {
      expect(service.parseEvents(null)).toEqual([]);
      expect(service.parseEvents({ foo: 'bar' })).toEqual([]);
      expect(service.parseEvents([{ crqid: 'x' }])).toEqual([]); // no status → skipped
      expect(() => service.parseEvents(42 as unknown)).not.toThrow();
    });
  });

  // Regression for the Wave-1 audit HIGH: MSG91 SMS DLR reports a NUMERIC status code + a `CRQID`
  // (uppercase) correlation field; the classifiers must map the codes and the parser must read CRQID.
  describe('MSG91 SMS DLR numeric codes + CRQID (real payload shape)', () => {
    const dlr = (over: Record<string, unknown> = {}) => ({
      requestId: 'req-sms-1',
      telNum: '919876500011',
      status: '1',
      deliveryTime: '2026-03-19T16:58:07+05:30',
      CRQID: 'rcpt-1',
      eventName: 'delivered',
      failureReason: '',
      ...over,
    });

    it('parses the real SMS DLR payload: numeric status, CRQID (uppercase), requestId, deliveryTime', () => {
      const [ev] = service.parseEvents(dlr());
      expect(ev).toMatchObject({ crqid: 'rcpt-1', requestId: 'req-sms-1', status: '1' });
      expect(typeof ev.at).toBe('number');
    });

    it('treats CRQID "0" (MSG91 default when none sent) as absent', () => {
      const [ev] = service.parseEvents(dlr({ CRQID: '0' }));
      expect(ev.crqid).toBeUndefined();
    });

    it('code "1" → DELIVERED', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique
        .mockResolvedValueOnce({ id: 'rcpt-1' })
        .mockResolvedValue({ providerResponse: null });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook(dlr());
      expect(res.updated).toBe(1);
      expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'rcpt-1', deliveredAt: null, status: { notIn: ['FAILED', 'READ'] } },
        data: { status: 'DELIVERED', deliveredAt: expect.any(Date) },
      });
    });

    it.each(['2', '9', '16', '17', '20', '25'])('code "%s" → FAILED', async (code) => {
      mockPrisma.messageDeliveryReceipt.findUnique
        .mockResolvedValueOnce({ id: 'rcpt-1' })
        .mockResolvedValue({ providerResponse: null });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook(dlr({ status: code, eventName: 'failed', failureReason: 'x' }));
      expect(res.updated).toBe(1);
      const call = mockPrisma.messageDeliveryReceipt.updateMany.mock.calls[0][0];
      expect(call.data.status).toBe('FAILED');
    });

    it('code "0" (Sent) → no flip', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'rcpt-1' });
      const res = await service.handleWebhook(dlr({ status: '0', eventName: 'sent' }));
      expect(res.updated).toBe(0);
      expect(mockPrisma.messageDeliveryReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('correlation', () => {
    it('resolves by crqid (unique) first', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r1' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook([{ crqid: 'r1', status: 'delivered' }]);
      expect(res).toEqual({ processed: 1, updated: 1 });
      expect(mockPrisma.messageDeliveryReceipt.findUnique).toHaveBeenCalledWith({
        where: { crqid: 'r1' },
        select: { id: true },
      });
      expect(mockPrisma.messageDeliveryReceipt.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to msg91RequestId (most recent) when crqid does not resolve', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce(null); // crqid miss
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValueOnce({ id: 'r2' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook([
        { crqid: 'ghost', requestId: 'req2', status: 'delivered' },
      ]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.messageDeliveryReceipt.findFirst).toHaveBeenCalledWith({
        where: { msg91RequestId: 'req2' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
    });

    it('ignores an event whose crqid and requestId resolve nothing', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValue(null);
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValue(null);
      const res = await service.handleWebhook([{ requestId: 'ghost', status: 'delivered' }]);
      expect(res).toEqual({ processed: 1, updated: 0 });
      expect(mockPrisma.messageDeliveryReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('SENT→DELIVERED (idempotent guarded transition)', () => {
    it('flips once on the first callback, no-ops on a duplicate', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique
        .mockResolvedValueOnce({ id: 'r1' }) // correlation (1st call)
        .mockResolvedValue({ providerResponse: null }); // merge read
      mockPrisma.messageDeliveryReceipt.updateMany
        .mockResolvedValueOnce({ count: 1 }) // first delivered flips
        .mockResolvedValueOnce({ count: 0 }); // duplicate flips nothing

      const first = await service.handleWebhook([{ crqid: 'r1', status: 'delivered' }]);
      expect(first).toEqual({ processed: 1, updated: 1 });
      expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', deliveredAt: null, status: { notIn: ['FAILED', 'READ'] } },
        data: { status: 'DELIVERED', deliveredAt: expect.any(Date) },
      });

      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r1' });
      const dup = await service.handleWebhook([{ crqid: 'r1', status: 'delivered' }]);
      expect(dup).toEqual({ processed: 1, updated: 0 });
    });
  });

  describe('→READ implies delivered', () => {
    it('flips READ then atomically claims deliveredAt', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r2' });
      mockPrisma.messageDeliveryReceipt.updateMany
        .mockResolvedValueOnce({ count: 1 }) // READ transition
        .mockResolvedValueOnce({ count: 1 }); // deliveredAt claim

      const res = await service.handleWebhook([{ crqid: 'r2', status: 'read' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'r2', readAt: null, status: { notIn: ['FAILED'] } },
        data: { status: 'READ', readAt: expect.any(Date) },
      });
      expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'r2', deliveredAt: null },
        data: { deliveredAt: expect.any(Date) },
      });
    });
  });

  describe('→FAILED (guarded; no downgrade of a terminal row)', () => {
    it('flips a non-terminal row to FAILED with the reason', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r3' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await service.handleWebhook([{ crqid: 'r3', status: 'failed', reason: 'DND' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'r3', status: { notIn: ['FAILED', 'DELIVERED', 'READ'] } },
        data: { status: 'FAILED', failureReason: 'DND' },
      });
    });

    it('does NOT downgrade a DELIVERED/READ row (guard matches 0 rows → no-op)', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r4' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await service.handleWebhook([{ crqid: 'r4', status: 'failed' }]);
      expect(res.updated).toBe(0);
      // The merge/update side-effect must not run when nothing flipped.
      expect(mockPrisma.messageDeliveryReceipt.update).not.toHaveBeenCalled();
    });

    it('classifies undelivered/rejected/blocked as failures, not deliveries', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValue({ id: 'r5' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      for (const status of ['undelivered', 'rejected', 'blocked', 'expired']) {
        mockPrisma.messageDeliveryReceipt.updateMany.mockClear();
        mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'r5' });
        await service.handleWebhook([{ crqid: 'r5', status }]);
        const call = mockPrisma.messageDeliveryReceipt.updateMany.mock.calls[0][0];
        expect(call.data.status).toBe('FAILED');
      }
    });
  });

  // Wave 2: a transactional-WhatsApp receipt receives WhatsApp TEXT statuses (delivered then read)
  // via the shared service (reached from the WhatsApp status webhook on a broadcast miss). This
  // drives the real guarded transitions over a STATEFUL fake to prove the end-to-end sequence
  // SENT→DELIVERED→READ on one receipt row.
  describe('transactional WhatsApp DLR sequence: SENT → DELIVERED → READ (stateful)', () => {
    it('a delivered then read sequence transitions the same receipt SENT→DELIVERED→READ', async () => {
      const row: any = {
        id: 'rcpt-wa-1',
        crqid: 'crq-wa-1',
        status: 'SENT',
        deliveredAt: null,
        readAt: null,
        providerResponse: null,
      };
      // Stateful fake: findUnique resolves by crqid (correlation) or by id (merge read); updateMany
      // honours the not-yet-set-timestamp / status guards exactly like Prisma updateMany.
      mockPrisma.messageDeliveryReceipt.findUnique.mockImplementation(({ where }: any) => {
        if (where.crqid && where.crqid === row.crqid) return Promise.resolve({ id: row.id });
        if (where.id && where.id === row.id) return Promise.resolve({ providerResponse: row.providerResponse });
        return Promise.resolve(null);
      });
      mockPrisma.messageDeliveryReceipt.updateMany.mockImplementation(({ where, data }: any) => {
        if (where.id !== row.id) return Promise.resolve({ count: 0 });
        if ('deliveredAt' in where && where.deliveredAt === null && row.deliveredAt !== null)
          return Promise.resolve({ count: 0 });
        if ('readAt' in where && where.readAt === null && row.readAt !== null)
          return Promise.resolve({ count: 0 });
        if (where.status?.notIn && where.status.notIn.includes(row.status))
          return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      });
      mockPrisma.messageDeliveryReceipt.update.mockImplementation(({ data }: any) => {
        Object.assign(row, data);
        return Promise.resolve(row);
      });

      const d = await service.handleWebhook([{ crqid: 'crq-wa-1', status: 'delivered' }]);
      expect(d.updated).toBe(1);
      expect(row.status).toBe('DELIVERED');
      expect(row.deliveredAt).toBeInstanceOf(Date);

      const r = await service.handleWebhook([{ crqid: 'crq-wa-1', status: 'read' }]);
      expect(r.updated).toBe(1);
      expect(row.status).toBe('READ');
      expect(row.readAt).toBeInstanceOf(Date);

      // A duplicate READ callback (MSG91 retry) is a no-op — no downgrade, no re-count.
      const dup = await service.handleWebhook([{ crqid: 'crq-wa-1', status: 'read' }]);
      expect(dup.updated).toBe(0);
      expect(row.status).toBe('READ');
    });
  });

  describe('reconcile (best-effort SMS poll)', () => {
    it('is a no-op when no rows are stuck', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValueOnce([]);
      const res = await service.reconcile();
      expect(res).toEqual({ checked: 0, updated: 0 });
      expect(mockMsg91.getSmsStatusByRequestId).not.toHaveBeenCalled();
    });

    it('flips a stuck row to DELIVERED when the poll reports delivered', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValueOnce([
        { id: 'r9', msg91RequestId: 'req9' },
      ]);
      mockMsg91.getSmsStatusByRequestId.mockResolvedValueOnce({ status: 'DELIVERED', raw: {} });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await service.reconcile();
      expect(res).toEqual({ checked: 1, updated: 1 });
      expect(mockMsg91.getSmsStatusByRequestId).toHaveBeenCalledWith('req9');
    });

    it('leaves a row untouched when the poll returns null (unknown shape / unconfigured)', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockResolvedValueOnce([
        { id: 'r9', msg91RequestId: 'req9' },
      ]);
      mockMsg91.getSmsStatusByRequestId.mockResolvedValueOnce(null);
      const res = await service.reconcile();
      expect(res).toEqual({ checked: 1, updated: 0 });
      expect(mockPrisma.messageDeliveryReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('never throws when the receipt table is missing (pre-migration)', async () => {
      mockPrisma.messageDeliveryReceipt.findMany.mockRejectedValueOnce(new Error('no such table'));
      await expect(service.reconcile()).resolves.toEqual({ checked: 0, updated: 0 });
    });
  });

  // ── Wave 3 (light D1): OTP delivery correlation via the OtpCode fallback ─────────────────────
  describe('OTP fallback correlation (light D1)', () => {
    it('an OTP DLR (numeric "1") correlated by msg91RequestId flips OtpCode → DELIVERED', async () => {
      // No receipt matches (crqid absent, requestId misses the receipt table) → fall to OtpCode.
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValueOnce(null);
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({ id: 'otp-1' });
      mockPrisma.otpCode.updateMany.mockResolvedValueOnce({ count: 1 });

      const res = await service.handleWebhook([{ requestId: 'req-otp-1', status: '1' }]);
      expect(res).toEqual({ processed: 1, updated: 1 });
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith({
        where: { msg91RequestId: 'req-otp-1' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-1', deliveredAt: null, deliveryStatus: { notIn: ['FAILED'] } },
        data: { deliveryStatus: 'DELIVERED', deliveredAt: expect.any(Date) },
      });
    });

    it('is idempotent — a duplicate DELIVERED callback flips nothing (count 0 → not counted)', async () => {
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValue(null);
      mockPrisma.otpCode.findFirst.mockResolvedValue({ id: 'otp-1' });
      mockPrisma.otpCode.updateMany.mockResolvedValueOnce({ count: 0 }); // already delivered

      const res = await service.handleWebhook([{ requestId: 'req-otp-1', status: 'delivered' }]);
      expect(res.updated).toBe(0);
    });

    it('an OTP failure code ("2") flips OtpCode → FAILED, no-downgrade guard', async () => {
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValueOnce(null);
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce({ id: 'otp-2' });
      mockPrisma.otpCode.updateMany.mockResolvedValueOnce({ count: 1 });

      const res = await service.handleWebhook([{ requestId: 'req-otp-2', status: '2' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp-2', deliveryStatus: { notIn: ['DELIVERED', 'FAILED'] } },
        data: { deliveryStatus: 'FAILED' },
      });
    });

    it('ignores an OTP DLR whose requestId matches no OtpCode', async () => {
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValueOnce(null);
      mockPrisma.otpCode.findFirst.mockResolvedValueOnce(null);
      const res = await service.handleWebhook([{ requestId: 'ghost', status: '1' }]);
      expect(res).toEqual({ processed: 1, updated: 0 });
      expect(mockPrisma.otpCode.updateMany).not.toHaveBeenCalled();
    });
  });

  // Ordering invariant: a MessageDeliveryReceipt ALWAYS wins; the OtpCode fallback is reached only
  // when BOTH receipt lookups (crqid, requestId) miss.
  describe('ordering: a receipt match wins over OtpCode', () => {
    it('does NOT touch OtpCode when a receipt matches by crqid', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValueOnce({ id: 'rcpt-1' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook([{ crqid: 'rcpt-1', requestId: 'req-x', status: 'delivered' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.otpCode.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT touch OtpCode when a receipt matches by requestId', async () => {
      mockPrisma.messageDeliveryReceipt.findUnique.mockResolvedValue(null); // no crqid match
      mockPrisma.messageDeliveryReceipt.findFirst.mockResolvedValueOnce({ id: 'rcpt-2' });
      mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.handleWebhook([{ requestId: 'req-shared', status: 'delivered' }]);
      expect(res.updated).toBe(1);
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getOtpDeliveryStats (aggregate delivery-rate)', () => {
    it('reduces groupBy(deliveryStatus) into counts + deliveryRate', async () => {
      mockPrisma.otpCode.groupBy.mockResolvedValueOnce([
        { deliveryStatus: 'DELIVERED', _count: { _all: 80 } },
        { deliveryStatus: 'FAILED', _count: { _all: 20 } },
        { deliveryStatus: 'SENT', _count: { _all: 15 } },
        { deliveryStatus: null, _count: { _all: 5 } },
      ]);
      const res = await service.getOtpDeliveryStats();
      expect(res).toEqual({
        total: 120,
        delivered: 80,
        failed: 20,
        sent: 15,
        pending: 5,
        deliveryRate: 0.8, // 80 / (80 + 20)
      });
    });

    it('deliveryRate is null when no OTP has a terminal outcome yet', async () => {
      mockPrisma.otpCode.groupBy.mockResolvedValueOnce([
        { deliveryStatus: 'SENT', _count: { _all: 10 } },
        { deliveryStatus: null, _count: { _all: 3 } },
      ]);
      const res = await service.getOtpDeliveryStats();
      expect(res).toMatchObject({ total: 13, delivered: 0, failed: 0, sent: 10, pending: 3, deliveryRate: null });
    });

    it('applies the (partial) per-tenant filter when clientId is given', async () => {
      mockPrisma.otpCode.groupBy.mockResolvedValueOnce([]);
      await service.getOtpDeliveryStats({ clientId: 'deoleo' });
      expect(mockPrisma.otpCode.groupBy).toHaveBeenCalledWith({
        by: ['deliveryStatus'],
        where: { user: { is: { clientId: 'deoleo' } } },
        _count: { _all: true },
      });
    });
  });
});
