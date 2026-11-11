// notifyUserWithChannels — secret vars (gift-card PIN / voucher code):
//  - maskedVars replace the clear value in EVERY persisted copy (IN_APP + PUSH variables, the SMS
//    queue row) while the WhatsApp SEND still carries the clear value;
//  - secretValues are scrubbed from the stored WhatsApp failureReason (shown to CLIENT_ADMIN in the
//    delivery report) and from what is handed to msg91 for its own logs.
// Run: npx jest src/notifications/notifications.service.secret-vars.spec.ts

import { NotificationsService } from './notifications.service';
import { scrubSecrets } from './scrub-secrets';
import { Msg91Service } from './msg91.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedChannelConfig } from '../notification-templates/notification-templates.config';

const CODE = '6001220012345678';
const PIN = '482913';
const COMBINED = `${CODE} | PIN: ${PIN}`;

function makeSvc(send: jest.Mock, cfgOver: Partial<ResolvedChannelConfig> = {}) {
  const queueRows: Record<string, unknown>[] = [];
  const receiptUpdates: Record<string, unknown>[] = [];
  const prisma = {
    notificationQueue: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        queueRows.push(data);
        return Promise.resolve({ id: `q${queueRows.length}` });
      }),
    },
    messageDeliveryReceipt: {
      create: jest.fn(({ data }: { data: { crqid: string } }) => Promise.resolve({ id: 'r1', crqid: data.crqid })),
      updateMany: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        receiptUpdates.push(data);
        return Promise.resolve({ count: 1 });
      }),
    },
  } as unknown as PrismaService;
  const msg91 = { sendWhatsappTemplate: send } as unknown as Msg91Service;
  const svc = new NotificationsService(prisma, msg91, {} as never);
  const cfg: ResolvedChannelConfig = {
    mode: 'BOTH',
    whatsappTemplate: 'voucher_code',
    smsTemplateId: 'SMS-T1',
    masterSms: true,
    masterWhatsapp: false,
    ...cfgOver,
  };
  (svc as unknown as { templates: unknown }).templates = { getChannelConfig: jest.fn().mockResolvedValue(cfg) };
  return { svc, queueRows, receiptUpdates };
}

const notify = (svc: NotificationsService) =>
  svc.notifyUserWithChannels({
    clientId: 'bajaj',
    userId: 'u1',
    eventKey: 'VOUCHER_ISSUED',
    recipientPhone: '9990000001',
    vars: { ownerName: 'Asha', amount: '₹500', program: 'Bajaj Loyalty', voucherName: 'Croma', code: COMBINED },
    maskedVars: { code: `${CODE} | PIN: ••••` },
    secretValues: [COMBINED, CODE, PIN],
    subject: 'Your voucher code',
    body: 'Your Croma voucher is ready — card no. and PIN are in My Orders.',
    event: 'VOUCHER_ISSUED',
  });

describe('NotificationsService — secret vars', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, DELIVERY_RECEIPTS_ENABLED: 'true' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('no persisted row (IN_APP, PUSH, SMS) holds the PIN; the WhatsApp send still carries it', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-1' });
    const { svc, queueRows } = makeSvc(send);
    await notify(svc);

    expect(queueRows.map((r) => r.channel)).toEqual(['IN_APP', 'PUSH', 'SMS']);
    for (const row of queueRows) expect(JSON.stringify(row)).not.toContain(PIN);
    const sms = queueRows.find((r) => r.channel === 'SMS')!;
    expect(sms.variables).toMatchObject({ code: `${CODE} | PIN: ••••` });
    expect(send).toHaveBeenCalledWith(
      '9990000001',
      'voucher_code',
      ['Asha', '₹500', 'Bajaj Loyalty', 'Croma', COMBINED],
      expect.objectContaining({ secretValues: [COMBINED, CODE, PIN] }),
    );
  });

  it('a failed send stores a scrubbed failureReason (never the code / PIN / combined value)', async () => {
    const send = jest.fn().mockRejectedValue(new Error(`Failed to send WhatsApp template voucher_code: invalid param "${COMBINED}" (pin ${PIN})`));
    const { svc, receiptUpdates } = makeSvc(send);
    await expect(notify(svc)).resolves.toBeUndefined();
    const failed = receiptUpdates.find((u) => u.status === 'FAILED')!;
    expect(failed.failureReason).toBe('Error: Failed to send WhatsApp template voucher_code: invalid param "••••" (pin ••••)');
    expect(String(failed.failureReason)).not.toContain(CODE);
    expect(String(failed.failureReason)).not.toContain(PIN);
  });

  it('no maskedVars / secretValues → stored rows and the send are unchanged (no-PIN callers byte-identical)', async () => {
    const send = jest.fn().mockResolvedValue({ requestId: 'REQ-2' });
    const { svc, queueRows } = makeSvc(send);
    await svc.notifyUserWithChannels({
      clientId: 'bajaj', userId: 'u1', eventKey: 'VOUCHER_ISSUED', recipientPhone: '9990000001',
      vars: { ownerName: 'Asha', amount: '₹500', program: 'Bajaj Loyalty', voucherName: 'Croma', code: 'AMZ-1' },
      subject: 'Your voucher code', body: 'Your Croma code: AMZ-1',
    });
    expect(queueRows.find((r) => r.channel === 'SMS')!.variables).toMatchObject({ code: 'AMZ-1' });
    expect(send.mock.calls[0][3]).toEqual({ crqid: expect.any(String) });
  });
});

describe('scrubSecrets', () => {
  it('replaces longest first, ignores blanks, leaves text without secrets unchanged', () => {
    expect(scrubSecrets(`x ${COMBINED} y ${CODE}`, [CODE, COMBINED, '', null, '   '])).toBe('x •••• y ••••');
    expect(scrubSecrets('nothing here', [CODE])).toBe('nothing here');
    expect(scrubSecrets('abc', undefined)).toBe('abc');
  });
});
