// Unit tests for PushDeliveryWorker — the queue drainer's PUSH + SMS legs.
// Verifies: the SMS leg selects only channel='SMS' QUEUED rows and sends via Msg91Service.sendSms,
// marking SENT / retrying to FAILED; the PUSH leg is untouched (still selects only PUSH); IN_APP
// rows are NEVER selected; and the whole drain is gated on PUSH_WORKER_ENABLED.
// Run: npx jest src/push/push-delivery.worker.spec.ts

import { PushDeliveryWorker } from './push-delivery.worker';
import { PrismaService } from '../prisma/prisma.service';
import { PushSenderService } from './push-sender.service';
import { Msg91Service } from '../notifications/msg91.service';

interface Row {
  id: string;
  channel: string;
  status: string;
  userId: string;
  subject: string | null;
  body: string;
  recipientPhone: string | null;
  templateId: string | null;
  variables: unknown;
  retryCount: number;
  maxRetries: number;
  processedAt: Date | null;
}

function makeRow(over: Partial<Row>): Row {
  return {
    id: 'r1',
    channel: 'SMS',
    status: 'QUEUED',
    userId: 'u1',
    subject: null,
    body: 'body',
    recipientPhone: '9990000001',
    templateId: 'dlt-1',
    variables: { ownerName: 'Asha' },
    retryCount: 0,
    maxRetries: 3,
    processedAt: null,
    ...over,
  };
}

/**
 * A tiny in-memory notificationQueue supporting findMany(where channel/status + {not:null}
 * filters), update, and updateMany (the atomic-claim primitive: honours a status guard and
 * returns the matched count).
 */
class FakeQueue {
  constructor(public rows: Row[]) {}
  findMany({
    where,
    take,
  }: {
    where: {
      channel: string;
      status: string;
      templateId?: { not: null };
      recipientPhone?: { not: null };
    };
    take?: number;
  }) {
    const out = this.rows.filter((r) => {
      if (r.channel !== where.channel || r.status !== where.status) return false;
      // Honour the {not:null} column filters the SMS leg now applies.
      if (where.templateId?.not === null && r.templateId === null) return false;
      if (where.recipientPhone?.not === null && r.recipientPhone === null) return false;
      return true;
    });
    return Promise.resolve(typeof take === 'number' ? out.slice(0, take) : out);
  }
  update({ where, data }: { where: { id: string }; data: Partial<Row> }) {
    const row = this.rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return Promise.resolve(row);
  }
  /** Atomic claim primitive: match id + status guard, apply data, return {count}. */
  updateMany({ where, data }: { where: { id: string; status?: string }; data: Partial<Row> }) {
    const matched = this.rows.filter(
      (r) => r.id === where.id && (where.status === undefined || r.status === where.status),
    );
    for (const r of matched) Object.assign(r, data);
    return Promise.resolve({ count: matched.length });
  }
}

function makeWorker(rows: Row[], msg91Send: jest.Mock, senderSend?: jest.Mock) {
  const queue = new FakeQueue(rows);
  const deliveryLog = { create: jest.fn().mockResolvedValue({}) };
  const prisma = { notificationQueue: queue, notificationDeliveryLog: deliveryLog } as unknown as PrismaService;
  const sender = { sendToUser: senderSend ?? jest.fn().mockResolvedValue(1) } as unknown as PushSenderService;
  const msg91 = { sendSms: msg91Send } as unknown as Msg91Service;
  return { worker: new PushDeliveryWorker(prisma, sender, msg91), queue, deliveryLog, msg91Send };
}

describe('PushDeliveryWorker — SMS + PUSH drain legs', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, PUSH_WORKER_ENABLED: 'true' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.clearAllMocks();
  });

  it('is a no-op when PUSH_WORKER_ENABLED is not "true"', async () => {
    process.env = { ...OLD_ENV, PUSH_WORKER_ENABLED: 'false' };
    const send = jest.fn().mockResolvedValue(undefined);
    const { worker, deliveryLog } = makeWorker([makeRow({})], send);
    await worker.drain();
    expect(send).not.toHaveBeenCalled();
    expect(deliveryLog.create).not.toHaveBeenCalled();
  });

  it('SMS leg: sends a QUEUED SMS row via sendSms(phone, templateId, variables) and marks it SENT', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const row = makeRow({ recipientPhone: '9990000001', templateId: 'dlt-1', variables: { ownerName: 'Asha', points: 120 } });
    const { worker, queue } = makeWorker([row], send);
    await worker.drain();
    expect(send).toHaveBeenCalledTimes(1);
    // variables are coerced to a { name: string } map before the send.
    expect(send).toHaveBeenCalledWith('9990000001', 'dlt-1', { ownerName: 'Asha', points: '120' });
    expect(queue.rows[0].status).toBe('SENT');
    expect(queue.rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('SMS leg: a send failure re-queues (retry bump) until maxRetries → terminal FAILED', async () => {
    const send = jest.fn().mockRejectedValue(new Error('MSG91 down'));
    const row = makeRow({ retryCount: 0, maxRetries: 2 });
    const { worker, queue } = makeWorker([row], send);

    await worker.drain(); // retry 0 → 1, back to QUEUED
    expect(queue.rows[0].status).toBe('QUEUED');
    expect(queue.rows[0].retryCount).toBe(1);

    await worker.drain(); // retry 1 → 2 == max → FAILED
    expect(queue.rows[0].status).toBe('FAILED');
    expect(queue.rows[0].retryCount).toBe(2);
  });

  it('SMS leg: a legacy row with NULL templateId/recipientPhone is NEVER selected (not sent, not failed, stays QUEUED)', async () => {
    // Pre-existing legacy dead-SMS rows (templateId/phone NULL, enqueued before this feature) must
    // never be picked up — they stay QUEUED and are never churned to FAILED.
    const send = jest.fn().mockResolvedValue(undefined);
    const nullTemplate = makeRow({ id: 'legacy1', recipientPhone: '9990000001', templateId: null });
    const nullPhone = makeRow({ id: 'legacy2', recipientPhone: null, templateId: 'dlt-1' });
    const { worker, queue, deliveryLog } = makeWorker([nullTemplate, nullPhone], send);
    await worker.drain();
    expect(send).not.toHaveBeenCalled();
    // Neither legacy row was touched — still QUEUED, no delivery log written for them.
    expect(queue.rows.find((r) => r.id === 'legacy1')!.status).toBe('QUEUED');
    expect(queue.rows.find((r) => r.id === 'legacy2')!.status).toBe('QUEUED');
    expect(deliveryLog.create).not.toHaveBeenCalled();
  });

  it('SMS leg: claims a row (QUEUED→PROCESSING) before sending', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const row = makeRow({ id: 's1' });
    const { worker, queue } = makeWorker([row], send);
    const claimSpy = jest.spyOn(queue, 'updateMany');
    await worker.drain();
    // The atomic claim ran with the status guard before the send.
    expect(claimSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1', status: 'QUEUED' }, data: { status: 'PROCESSING' } }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.rows[0].status).toBe('SENT');
  });

  it('SMS leg: a row already claimed by another instance (claim count 0) sends nothing', async () => {
    // Simulate the multi-instance race: findMany saw the row QUEUED, but a concurrent drainer
    // claimed it between the select and this claim → updateMany matches 0 rows → we must skip.
    const send = jest.fn().mockResolvedValue(undefined);
    const row = makeRow({ id: 's1' });
    const { worker, queue } = makeWorker([row], send);
    jest.spyOn(queue, 'updateMany').mockResolvedValueOnce({ count: 0 });
    await worker.drain();
    expect(send).not.toHaveBeenCalled();
  });

  it('SMS leg: a second drain of an already-claimed (PROCESSING) row sends nothing', async () => {
    // A row already claimed (PROCESSING) is never re-selected (status filter) → no double-send.
    const send = jest.fn().mockResolvedValue(undefined);
    const row = makeRow({ id: 's1', status: 'PROCESSING' });
    const { worker } = makeWorker([row], send);
    await worker.drain();
    expect(send).not.toHaveBeenCalled();
  });

  it('never selects IN_APP rows for either leg', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const senderSend = jest.fn().mockResolvedValue(1);
    const inApp = makeRow({ id: 'in1', channel: 'IN_APP', status: 'QUEUED' });
    const { worker, queue } = makeWorker([inApp], send, senderSend);
    await worker.drain();
    expect(send).not.toHaveBeenCalled();
    expect(senderSend).not.toHaveBeenCalled();
    // The IN_APP row is left untouched (never marked).
    expect(queue.rows[0].status).toBe('QUEUED');
  });

  it('PUSH leg still sends only PUSH rows and leaves SMS untouched within a mixed batch is handled by each leg', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const senderSend = jest.fn().mockResolvedValue(2);
    const push = makeRow({ id: 'p1', channel: 'PUSH', status: 'QUEUED', subject: 'Hi' });
    const sms = makeRow({ id: 's1', channel: 'SMS', status: 'QUEUED' });
    const { worker, queue } = makeWorker([push, sms], send, senderSend);
    await worker.drain();
    // PUSH leg sent the push row via the web-push sender.
    expect(senderSend).toHaveBeenCalledTimes(1);
    expect(queue.rows.find((r) => r.id === 'p1')!.status).toBe('SENT');
    // SMS leg sent the sms row via sendSms.
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.rows.find((r) => r.id === 's1')!.status).toBe('SENT');
  });
});
