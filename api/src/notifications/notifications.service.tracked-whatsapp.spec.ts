// NotificationsService.sendTrackedWhatsappTemplate (Voucher Dispersal): a direct, receipt-tracked
// WhatsApp to a bare phone that is not a login user. Receipt QUEUED → send with crqid → SENT; a send
// that throws → FAILED with the secret scrubbed, never rejects; tracking off → no receipt, still sends.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotificationsService } from './notifications.service';

function make() {
  const receipts = new Map<string, any>();
  let seq = 0;
  const prisma: any = {
    messageDeliveryReceipt: {
      create: jest.fn(async ({ data }: any) => {
        const id = `r${++seq}`;
        receipts.set(id, { id, ...data });
        return { id, crqid: data.crqid };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = receipts.get(where.id);
        if (!r || (where.status && r.status !== where.status)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
  };
  const msg91: any = { sendWhatsappTemplate: jest.fn(async () => ({ requestId: 'req-1' })) };
  const svc = new NotificationsService(prisma, msg91, {} as any);
  return { svc, prisma, msg91, receipts };
}

const params = {
  clientId: 'gifsy',
  eventKey: 'VOUCHER_DISPERSAL',
  phone: '9876543210',
  templateName: 'voucher_code',
  bodyValues: ['Asha', '₹1,000', 'Gifsy Rewards', 'Amazon Pay', 'CODE-SECRET-1234'],
  secretValues: ['CODE-SECRET-1234'],
};

describe('sendTrackedWhatsappTemplate', () => {
  const prev = process.env.DELIVERY_RECEIPTS_ENABLED;
  afterEach(() => {
    process.env.DELIVERY_RECEIPTS_ENABLED = prev;
  });

  it('creates a receipt, sends with its crqid + secrets, marks it SENT and returns the receipt id', async () => {
    process.env.DELIVERY_RECEIPTS_ENABLED = 'true';
    const t = make();
    const res = await t.svc.sendTrackedWhatsappTemplate(params);
    expect(res).toEqual({ receiptId: 'r1', requestId: 'req-1', error: null });
    const [phone, tpl, vals, opts] = t.msg91.sendWhatsappTemplate.mock.calls[0];
    expect([phone, tpl, vals]).toEqual(['9876543210', 'voucher_code', params.bodyValues]);
    expect(opts.crqid).toBe(t.receipts.get('r1').crqid);
    expect(opts.secretValues).toEqual(['CODE-SECRET-1234']);
    expect(t.receipts.get('r1')).toMatchObject({ clientId: 'gifsy', eventKey: 'VOUCHER_DISPERSAL', status: 'SENT', msg91RequestId: 'req-1' });
  });

  it('a send that throws → receipt FAILED, error returned with the code scrubbed, never rejects', async () => {
    process.env.DELIVERY_RECEIPTS_ENABLED = 'true';
    const t = make();
    t.msg91.sendWhatsappTemplate.mockRejectedValueOnce(new Error('MSG91 400: bad value CODE-SECRET-1234'));
    const res = await t.svc.sendTrackedWhatsappTemplate(params);
    expect(res.receiptId).toBe('r1');
    expect(res.error).toBeTruthy();
    expect(res.error).not.toContain('CODE-SECRET-1234');
    expect(t.receipts.get('r1').status).toBe('FAILED');
    expect(t.receipts.get('r1').failureReason).not.toContain('CODE-SECRET-1234');
  });

  it('tracking off → no receipt, the send still fires', async () => {
    delete process.env.DELIVERY_RECEIPTS_ENABLED;
    const t = make();
    const res = await t.svc.sendTrackedWhatsappTemplate(params);
    expect(res).toEqual({ receiptId: null, requestId: 'req-1', error: null });
    expect(t.prisma.messageDeliveryReceipt.create).not.toHaveBeenCalled();
    expect(t.msg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
  });
});
