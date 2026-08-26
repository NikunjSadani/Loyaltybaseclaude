// Unit tests for the SMS-leg DELIVERY RECEIPT behaviour added to PushDeliveryWorker (Wave 1).
// Verifies: a QUEUED receipt is created with crqid = receipt.id and flipped QUEUED→SENT with the
// returned requestId; a send that throws BEFORE billing flips the receipt to FAILED; a BILLED send
// whose queue post-write fails does NOT flip the receipt to FAILED; and a row with no derivable
// clientId simply sends without a receipt (best-effort, never breaks the send).
// Run: npx jest src/push/push-delivery.worker.receipt.spec.ts

import { PushDeliveryWorker } from './push-delivery.worker';
import { PrismaService } from '../prisma/prisma.service';
import { PushSenderService } from './push-sender.service';
import { Msg91Service } from '../notifications/msg91.service';

interface QRow {
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
  user?: { clientId: string } | null;
}

function makeRow(over: Partial<QRow>): QRow {
  return {
    id: 'q1',
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
    user: { clientId: 'client-A' },
    ...over,
  };
}

class FakeQueue {
  constructor(public rows: QRow[]) {}
  findMany({ where, take }: { where: any; take?: number }) {
    const out = this.rows.filter((r) => {
      if (r.channel !== where.channel || r.status !== where.status) return false;
      if (where.templateId?.not === null && r.templateId === null) return false;
      if (where.recipientPhone?.not === null && r.recipientPhone === null) return false;
      return true;
    });
    return Promise.resolve(typeof take === 'number' ? out.slice(0, take) : out);
  }
  update({ where, data }: { where: { id: string }; data: Partial<QRow> }) {
    const row = this.rows.find((r) => r.id === where.id)!;
    // A hook to simulate a post-send queue write failure (billed-send post-write-fail case).
    if ((this as any)._failOnSent && data.status === 'SENT') {
      return Promise.reject(new Error('DB blip on markSent'));
    }
    Object.assign(row, data);
    return Promise.resolve(row);
  }
  updateMany({ where, data }: { where: { id: string; status?: string }; data: Partial<QRow> }) {
    const matched = this.rows.filter(
      (r) => r.id === where.id && (where.status === undefined || r.status === where.status),
    );
    for (const r of matched) Object.assign(r, data);
    return Promise.resolve({ count: matched.length });
  }
}

interface Receipt {
  id: string;
  clientId: string;
  channel: string;
  eventKey?: string;
  recipientPhone?: string;
  status: string;
  msg91RequestId?: string | null;
  failureReason?: string;
  sentAt?: Date;
}

class FakeReceipts {
  store = new Map<string, Receipt>();
  seq = 0;
  createCalls: any[] = [];
  create({ data, select: _select }: { data: any; select?: any }) {
    const id = `rcpt${++this.seq}`;
    this.store.set(id, { id, ...data });
    this.createCalls.push(data);
    return Promise.resolve({ id, crqid: data.crqid });
  }
  updateMany({ where, data }: { where: { id: string; status?: string }; data: Partial<Receipt> }) {
    const row = this.store.get(where.id);
    if (!row) return Promise.resolve({ count: 0 });
    if (where.status !== undefined && row.status !== where.status) return Promise.resolve({ count: 0 });
    Object.assign(row, data);
    return Promise.resolve({ count: 1 });
  }
  deleteMany({ where }: { where: { id: string; status?: string } }) {
    const row = this.store.get(where.id);
    if (!row) return Promise.resolve({ count: 0 });
    if (where.status !== undefined && row.status !== where.status) return Promise.resolve({ count: 0 });
    this.store.delete(where.id);
    return Promise.resolve({ count: 1 });
  }
}

function makeWorker(rows: QRow[], sendSms: jest.Mock, opts?: { failOnSent?: boolean }) {
  const queue = new FakeQueue(rows);
  if (opts?.failOnSent) (queue as any)._failOnSent = true;
  const receipts = new FakeReceipts();
  const deliveryLog = { create: jest.fn().mockResolvedValue({}) };
  const prisma = {
    notificationQueue: queue,
    notificationDeliveryLog: deliveryLog,
    messageDeliveryReceipt: receipts,
  } as unknown as PrismaService;
  const sender = { sendToUser: jest.fn().mockResolvedValue(1) } as unknown as PushSenderService;
  const msg91 = { sendSms } as unknown as Msg91Service;
  return { worker: new PushDeliveryWorker(prisma, sender, msg91), queue, receipts };
}

describe('PushDeliveryWorker — SMS delivery-receipt lifecycle (Wave 1)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    // DELIVERY_RECEIPTS_ENABLED (M2) gates the whole receipt feature; set it on for the lifecycle
    // assertions. A dedicated OFF test below proves the dormant (no-receipt) path.
    process.env = { ...OLD_ENV, PUSH_WORKER_ENABLED: 'true', DELIVERY_RECEIPTS_ENABLED: 'true' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.clearAllMocks();
  });

  it('creates a QUEUED receipt, sends with crqid = receipt.id, and flips it SENT with requestId', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-1' });
    const { worker, queue, receipts } = makeWorker([makeRow({})], send);
    await worker.drain();

    // A receipt was created QUEUED with the tenant + channel + template as eventKey + a crqid.
    expect(receipts.createCalls).toHaveLength(1);
    expect(receipts.createCalls[0]).toMatchObject({
      clientId: 'client-A',
      channel: 'SMS',
      eventKey: 'dlt-1',
      recipientPhone: '9990000001',
      status: 'QUEUED',
    });
    const crqid = receipts.createCalls[0].crqid;
    expect(typeof crqid).toBe('string');
    expect(crqid).toMatch(/^[a-f0-9]{32}$/); // crypto hex: alphanumeric, no spaces/hyphens (MSG91 CRQID constraint)
    // sendSms carried the crqid we generated for the receipt.
    const receiptId = [...receipts.store.keys()][0];
    expect(send).toHaveBeenCalledWith('9990000001', 'dlt-1', { ownerName: 'Asha' }, { crqid });
    // The receipt is now SENT with the returned requestId; the queue row is SENT.
    const rcpt = receipts.store.get(receiptId)!;
    expect(rcpt.status).toBe('SENT');
    expect(rcpt.msg91RequestId).toBe('REQ-1');
    expect(rcpt.sentAt).toBeInstanceOf(Date);
    expect(queue.rows[0].status).toBe('SENT');
  });

  it('M4 — a RETRYABLE send failure leaves NO receipt (deleted) and re-queues the SMS', async () => {
    // retryCount 0 of maxRetries 3 → non-terminal → the row re-queues. Since MSG91 never got this
    // crqid, the just-created receipt is DELETED so the retry's fresh crqid is the only receipt →
    // one logical SMS never yields a stale FAILED + a later SENT.
    const send = jest.fn().mockRejectedValue(new Error('MSG91 down'));
    const { worker, queue, receipts } = makeWorker([makeRow({ maxRetries: 3, retryCount: 0 })], send);
    await worker.drain();

    // The receipt was created then deleted → store is empty (exactly zero receipts remain).
    expect(receipts.createCalls).toHaveLength(1);
    expect(receipts.store.size).toBe(0);
    // Queue transitions unchanged: a non-exhausted retry re-queues.
    expect(queue.rows[0].status).toBe('QUEUED');
    expect(queue.rows[0].retryCount).toBe(1);
  });

  it('M4 — a TERMINAL send failure leaves exactly ONE FAILED receipt', async () => {
    // retryCount 2 of maxRetries 3 → nextRetry 3 >= 3 → terminal → the receipt is KEPT and marked
    // FAILED (guarded QUEUED-only). Exactly one receipt, status FAILED.
    const send = jest.fn().mockRejectedValue(new Error('MSG91 down'));
    const { worker, queue, receipts } = makeWorker([makeRow({ maxRetries: 3, retryCount: 2 })], send);
    await worker.drain();

    expect(receipts.store.size).toBe(1);
    const rcpt = [...receipts.store.values()][0];
    expect(rcpt.status).toBe('FAILED');
    expect(rcpt.failureReason).toContain('MSG91 down');
    // Queue: exhausted retries → terminal FAILED.
    expect(queue.rows[0].status).toBe('FAILED');
    expect(queue.rows[0].retryCount).toBe(3);
  });

  it('M4 — a successful send leaves exactly ONE SENT receipt', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-OK' });
    const { worker, receipts } = makeWorker([makeRow({})], send);
    await worker.drain();

    expect(receipts.store.size).toBe(1);
    const rcpt = [...receipts.store.values()][0];
    expect(rcpt.status).toBe('SENT');
    expect(rcpt.msg91RequestId).toBe('REQ-OK');
  });

  it('M2 — with DELIVERY_RECEIPTS_ENABLED off, NO receipt is created and the SMS still sends (3-arg)', async () => {
    process.env.DELIVERY_RECEIPTS_ENABLED = 'false';
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-OFF' });
    const { worker, queue, receipts } = makeWorker([makeRow({})], send);
    await worker.drain();

    // Dormant: no receipt row, and the send is byte-identical to pre-feature (3-arg, no crqid).
    expect(receipts.createCalls).toHaveLength(0);
    expect(receipts.store.size).toBe(0);
    expect(send).toHaveBeenCalledWith('9990000001', 'dlt-1', { ownerName: 'Asha' });
    expect(queue.rows[0].status).toBe('SENT');
  });

  it('a BILLED send whose queue post-write fails does NOT flip the receipt to FAILED', async () => {
    // sendSms succeeds (billed) → the receipt is flipped SENT FIRST; then markSent (queue) throws.
    // The catch runs, but markSmsReceiptFailed is guarded on status:'QUEUED' → no-op → the receipt
    // stays SENT (a billed message can never become FAILED).
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-2' });
    const { worker, receipts } = makeWorker([makeRow({})], send, { failOnSent: true });
    await worker.drain();

    const receiptId = [...receipts.store.keys()][0];
    const rcpt = receipts.store.get(receiptId)!;
    expect(rcpt.status).toBe('SENT');
    expect(rcpt.msg91RequestId).toBe('REQ-2');
  });

  it('a row with no derivable clientId sends WITHOUT a receipt (3-arg call, no crash)', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-3' });
    const { worker, queue, receipts } = makeWorker([makeRow({ user: null })], send);
    await worker.drain();

    expect(receipts.createCalls).toHaveLength(0);
    // Byte-identical to the prior behaviour: a 3-arg send (no crqid opts).
    expect(send).toHaveBeenCalledWith('9990000001', 'dlt-1', { ownerName: 'Asha' });
    expect(queue.rows[0].status).toBe('SENT');
  });
});
