// Unit tests for the transactional-WhatsApp DELIVERY RECEIPT behaviour added to
// NotificationsService.notifyUserWithChannels (Wave 2 — DELIVERY-STATUS-REPORTING-SCOPE.md).
// Verifies: a QUEUED receipt is created (channel WHATSAPP, crqid = crypto hex) and the crqid is
// passed to sendWhatsappTemplate, then flipped QUEUED→SENT with the returned requestId; a send that
// throws BEFORE billing flips the receipt to FAILED (and never rejects the caller); a BILLED send
// whose SENT write blips does NOT flip the receipt to FAILED (billing-safe); and a receipt-create
// failure still fires the send unchanged (3-arg, no crqid).
// Run: npx jest src/notifications/notifications.service.whatsapp-receipt.spec.ts

import { NotificationsService } from './notifications.service';
import { Msg91Service } from './msg91.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedChannelConfig } from '../notification-templates/notification-templates.config';

interface Receipt {
  id: string;
  clientId: string;
  channel: string;
  crqid: string;
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
  failCreate = false;
  failSentWrite = false;

  create({ data }: { data: any; select?: any }) {
    if (this.failCreate) return Promise.reject(new Error('receipt table missing (pre-migration)'));
    const id = `rcpt${++this.seq}`;
    this.store.set(id, { id, ...data });
    this.createCalls.push(data);
    return Promise.resolve({ id, crqid: data.crqid });
  }
  updateMany({ where, data }: { where: { id: string; status?: string }; data: Partial<Receipt> }) {
    // Simulate a DB blip on the QUEUED→SENT write (billing-safety scenario).
    if (this.failSentWrite && data.status === 'SENT') {
      return Promise.reject(new Error('DB blip on SENT write'));
    }
    const row = this.store.get(where.id);
    if (!row) return Promise.resolve({ count: 0 });
    if (where.status !== undefined && row.status !== where.status) return Promise.resolve({ count: 0 });
    Object.assign(row, data);
    return Promise.resolve({ count: 1 });
  }
}

// A no-op notificationQueue so the free channels (IN_APP/PUSH) never crash the leg under test.
class FakeQueue {
  create() {
    return Promise.resolve({ id: 'q1' });
  }
}

function makeSvc(sendWhatsappTemplate: jest.Mock, cfgOver: Partial<ResolvedChannelConfig> = {}) {
  const receipts = new FakeReceipts();
  const prisma = {
    notificationQueue: new FakeQueue(),
    messageDeliveryReceipt: receipts,
  } as unknown as PrismaService;
  const msg91 = { sendWhatsappTemplate, sendSms: jest.fn() } as unknown as Msg91Service;
  const svc = new NotificationsService(prisma, msg91, {} as never);
  const cfg: ResolvedChannelConfig = {
    mode: 'WHATSAPP',
    whatsappTemplate: 'deoleo_points_credit',
    smsTemplateId: '',
    masterSms: false,
    masterWhatsapp: true,
    ...cfgOver,
  };
  (svc as unknown as { templates: unknown }).templates = {
    getChannelConfig: jest.fn().mockResolvedValue(cfg),
  };
  return { svc, receipts, msg91 };
}

const call = (svc: NotificationsService) =>
  svc.notifyUserWithChannels({
    clientId: 'deoleo',
    userId: 'u1',
    eventKey: 'POINTS_CREDITED',
    recipientPhone: '9990000001',
    vars: {
      ownerName: 'Asha',
      pointsCredited: 120,
      redeemableBalance: 500,
      monthYear: 'July 2026',
      dateCredited: '06 Jul 2026',
    },
    subject: 'Points credited',
    body: 'You earned 120 points.',
    includeFreeChannels: false, // focus on the paid WhatsApp leg
  });

describe('NotificationsService — transactional WhatsApp delivery-receipt lifecycle (Wave 2)', () => {
  it('creates a QUEUED WHATSAPP receipt, sends with {crqid}, and flips it SENT with requestId', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-1' });
    const { svc, receipts } = makeSvc(send);
    await call(svc);

    expect(receipts.createCalls).toHaveLength(1);
    expect(receipts.createCalls[0]).toMatchObject({
      clientId: 'deoleo',
      channel: 'WHATSAPP',
      eventKey: 'POINTS_CREDITED',
      recipientPhone: '9990000001',
      status: 'QUEUED',
    });
    const crqid = receipts.createCalls[0].crqid;
    expect(typeof crqid).toBe('string');
    // crypto hex: alphanumeric, no spaces/hyphens (MSG91 CRQID constraint) — no npm dep.
    expect(crqid).toMatch(/^[a-f0-9]{32}$/);

    // sendWhatsappTemplate carried the ordered body values AND the {crqid} we generated.
    expect(send).toHaveBeenCalledWith(
      '9990000001',
      'deoleo_points_credit',
      ['Asha', '120', '500', 'July 2026', '06 Jul 2026'],
      { crqid },
    );

    const rcpt = receipts.store.get('rcpt1')!;
    expect(rcpt.status).toBe('SENT');
    expect(rcpt.msg91RequestId).toBe('REQ-1');
    expect(rcpt.sentAt).toBeInstanceOf(Date);
  });

  it('tolerates a send that returns undefined (existing msg91 mock shape): receipt SENT, requestId null', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const { svc, receipts } = makeSvc(send);
    await call(svc);
    const rcpt = receipts.store.get('rcpt1')!;
    expect(rcpt.status).toBe('SENT');
    expect(rcpt.msg91RequestId ?? null).toBeNull();
  });

  it('a send that throws BEFORE billing flips the receipt to FAILED and never rejects the caller', async () => {
    const send = jest.fn().mockRejectedValue(new Error('MSG91 down'));
    const { svc, receipts } = makeSvc(send);
    await expect(call(svc)).resolves.toBeUndefined();
    const rcpt = receipts.store.get('rcpt1')!;
    expect(rcpt.status).toBe('FAILED');
    expect(rcpt.failureReason).toContain('MSG91 down');
  });

  it('a BILLED send whose SENT write blips does NOT end FAILED (billing-safe: stays QUEUED, never FAILED)', async () => {
    // send SUCCEEDS (billed) but the QUEUED→SENT updateMany throws. The helper swallows it, so the
    // outer catch never runs → markWhatsappReceiptFailed is never called → the billed message's
    // receipt is never downgraded to FAILED.
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-2' });
    const { svc, receipts } = makeSvc(send);
    receipts.failSentWrite = true;
    await expect(call(svc)).resolves.toBeUndefined();
    const rcpt = receipts.store.get('rcpt1')!;
    expect(rcpt.status).not.toBe('FAILED');
  });

  it('a receipt-create failure still fires the send UNCHANGED (3-arg, no crqid) and never rejects', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-3' });
    const { svc, receipts } = makeSvc(send);
    receipts.failCreate = true;
    await expect(call(svc)).resolves.toBeUndefined();
    expect(receipts.createCalls).toHaveLength(0);
    // Byte-identical to the prior behaviour: a 3-arg send (no crqid opts object).
    expect(send).toHaveBeenCalledWith('9990000001', 'deoleo_points_credit', [
      'Asha',
      '120',
      '500',
      'July 2026',
      '06 Jul 2026',
    ]);
  });
});
