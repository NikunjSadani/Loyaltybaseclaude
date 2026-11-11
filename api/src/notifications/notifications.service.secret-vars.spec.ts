// notifyUserWithChannels — secret vars (gift-card PIN / voucher code):
//  - maskedVars replace the clear value in EVERY persisted copy (IN_APP + PUSH variables, the SMS
//    queue row) while the WhatsApp SEND still carries the clear value;
//  - secretValues are scrubbed from the stored WhatsApp failureReason (shown to CLIENT_ADMIN in the
//    delivery report) and from what is handed to msg91 for its own logs.
// Run: npx jest src/notifications/notifications.service.secret-vars.spec.ts

import { NotificationsService } from './notifications.service';
import { scrubSecrets, SCRUBBED_PROVIDER_ERROR } from './scrub-secrets';
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
    maskedVars: { code: `${CODE} | PIN: see My Orders` },
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
    expect(sms.variables).toMatchObject({ code: `${CODE} | PIN: see My Orders` });
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
    // ANY secret in the reason withholds the WHOLE reason (no partial mask).
    expect(failed.failureReason).toBe(SCRUBBED_PROVIDER_ERROR);
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
  it('any secret match withholds the WHOLE text; blanks ignored; no match → unchanged', () => {
    expect(scrubSecrets(`x ${COMBINED} y`, [CODE, COMBINED, '', null, '   '])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets(`bad pin ${PIN}.`, [PIN])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('nothing here', [CODE])).toBe('nothing here');
    expect(scrubSecrets('abc', undefined)).toBe('abc');
    expect(scrubSecrets('abc', ['', '  ', null])).toBe('abc');
  });

  it('matches secrets as TOKENS only (not inside a longer alphanumeric run)', () => {
    expect(scrubSecrets('ref 148291300 failed', ['4829'])).toBe('ref 148291300 failed');
    expect(scrubSecrets('ref X4829 failed', ['4829'])).toBe('ref X4829 failed');
    expect(scrubSecrets('pin=4829&x=1', ['4829'])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('4829', ['4829'])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('"4829"', ['4829'])).toBe(SCRUBBED_PROVIDER_ERROR);
  });

  it('matches the JSON-escaped and URL-encoded forms of a secret (and case-insensitively)', () => {
    const pinWithNewline = '48\n29';
    expect(scrubSecrets(JSON.stringify({ message: `bad ${pinWithNewline}` }), [pinWithNewline])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('a"b\\"c', ['b"c'])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets(`url ?code=${encodeURIComponent(COMBINED)}`, [COMBINED])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('form code=6001+2200+1234', ['6001 2200 1234'])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets('code amz-abc-123 rejected', ['AMZ-ABC-123'])).toBe(SCRUBBED_PROVIDER_ERROR);
  });

  it('accepts any input: null/undefined → "", objects JSON-stringified, Errors stringified, never throws', () => {
    expect(scrubSecrets(null, [PIN])).toBe('');
    expect(scrubSecrets(undefined, [PIN])).toBe('');
    expect(scrubSecrets({ code: 400, detail: 'bad template' }, [PIN])).toBe('{"code":400,"detail":"bad template"}');
    expect(scrubSecrets({ detail: `pin ${PIN}` }, [PIN])).toBe(SCRUBBED_PROVIDER_ERROR);
    expect(scrubSecrets(new Error('boom'), [PIN])).toBe('Error: boom');
    expect(scrubSecrets(42, [])).toBe('42');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => scrubSecrets(circular, [PIN])).not.toThrow();
    expect(scrubSecrets(BigInt(7), [PIN])).toBe('7');
  });
});
