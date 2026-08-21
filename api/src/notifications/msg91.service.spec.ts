// Unit tests for Msg91Service.sendWhatsappTemplate — the MSG91 v5 bulk WhatsApp
// template path. Covers the request URL + body shape, the body_N variable mapping,
// the missing-authKey dev bypass, and the failure throws.
// Run: npx jest src/notifications/msg91.service.spec.ts

import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Msg91Service } from './msg91.service';

jest.mock('nodemailer');

/** A ConfigService stub backed by a plain map. */
function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('Msg91Service.sendWhatsappTemplate', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('builds the correct MSG91 bulk WhatsApp URL + body (template, to, body_N mapping)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'success' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_submission', [
      'Owner Name',
      '30 Jun 2026',
      'Olive Oil',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
    );
    // authkey rides in the header, never the body (mirrors sendOtp).
    expect(init.method).toBe('POST');
    expect(init.headers.authkey).toBe('key-123');

    const body = JSON.parse(init.body);
    // Default integrated number when MSG91_WHATSAPP_NUMBER is unset.
    expect(body.integrated_number).toBe('917003202293');
    expect(body.content_type).toBe('template');
    expect(body.payload.template.name).toBe('deoleo_kyc_submission');
    expect(body.payload.template.language).toEqual({ code: 'en', policy: 'deterministic' });

    const comp = body.payload.template.to_and_components[0];
    // Country code prepended to the recipient.
    expect(comp.to).toEqual(['919000000001']);
    // Ordered body values → body_1, body_2, body_3.
    expect(comp.components).toEqual({
      body_1: { type: 'text', value: 'Owner Name' },
      body_2: { type: 'text', value: '30 Jun 2026' },
      body_3: { type: 'text', value: 'Olive Oil' },
    });
  });

  it('uses MSG91_WHATSAPP_NUMBER override when configured', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_WHATSAPP_NUMBER: '910000000000' }),
    );
    await service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_approval', ['Owner', 'Program']);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.integrated_number).toBe('910000000000');
  });

  it('dev bypass: no authKey → logs + returns WITHOUT calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({})); // MSG91_AUTH_KEY undefined
    await expect(
      service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_submission', ['a', 'b', 'c']),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guard: a non-10-digit recipient (already-prefixed / +91 / short) is dropped, no fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    for (const bad of ['919830011252', '+919830011252', '98300', '98300112ab']) {
      await expect(
        service.sendWhatsappTemplate(bad, 'deoleo_kyc_approval', ['Owner', 'Program']),
      ).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when MSG91 returns HTTP 200 with {type:"error"}', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'error', message: 'bad template' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(
      service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_approval', ['Owner', 'Program']),
    ).rejects.toThrow(/bad template/);
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(
      service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_approval', ['Owner', 'Program']),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws a clear timeout error when fetch aborts', async () => {
    const fetchMock = jest.fn().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(
      service.sendWhatsappTemplate('9000000001', 'deoleo_kyc_approval', ['Owner', 'Program']),
    ).rejects.toThrow(/timeout/i);
  });
});

// Unit tests for Msg91Service.sendSms — the MSG91 v5 FLOW API (DLT template) path. Covers the
// request URL + body shape (template_id + recipients[{mobiles, ...vars}]), the missing-authKey
// dev bypass, the bare-10-digit recipient guard, and the failure throws (MSG91 error + timeout).
describe('Msg91Service.sendSms (v5 flow)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('builds the correct MSG91 flow URL + body (template_id + recipients with 91-prefixed mobiles + named vars)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'success' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await service.sendSms('9000000001', 'dlt-tpl-1', { ownerName: 'Asha', points: '120' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/flow/');
    expect(init.method).toBe('POST');
    // authkey rides in the header, never the body (mirrors sendOtp).
    expect(init.headers.authkey).toBe('key-123');
    const body = JSON.parse(init.body);
    expect(body.template_id).toBe('dlt-tpl-1');
    expect(body.recipients).toEqual([{ mobiles: '919000000001', ownerName: 'Asha', points: '120' }]);
  });

  it('dev bypass: no authKey → logs + returns WITHOUT calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({})); // MSG91_AUTH_KEY undefined
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', { a: 'b' })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guard: a non-10-digit recipient (already-prefixed / +91 / short / non-numeric) is dropped, no fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    for (const bad of ['919830011252', '+919830011252', '98300', '98300112ab']) {
      await expect(service.sendSms(bad, 'dlt-tpl-1', {})).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when MSG91 returns HTTP 200 with {type:"error"}', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'error', message: 'bad template' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', {})).rejects.toThrow(/bad template/);
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', {})).rejects.toThrow(/HTTP 500/);
  });

  it('throws a clear timeout error when fetch aborts', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', {})).rejects.toThrow(/timeout/i);
  });
});

// Covers the per-tenant, per-purpose OTP template override on sendOtp: the templateId
// param wins when non-empty, else the global env template is used — and the dev bypasses
// (FIXED_OTP, missing authKey) still short-circuit BEFORE any fetch.
describe('Msg91Service.sendOtp — per-tenant template override', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('uses the override templateId in the request body when provided (non-empty)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'success' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_OTP_TEMPLATE_ID: 'env-tpl' }),
    );
    await service.sendOtp('9000000001', '123456', 'SMS', 'tenant-tpl');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://control.msg91.com/api/v5/otp');
    const body = JSON.parse(init.body);
    expect(body.template_id).toBe('tenant-tpl');
    expect(body.mobile).toBe('919000000001');
    expect(body.otp).toBe('123456');
  });

  it('trims the override templateId before use', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_OTP_TEMPLATE_ID: 'env-tpl' }),
    );
    await service.sendOtp('9000000001', '123456', 'SMS', '  tenant-tpl  ');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('tenant-tpl');
  });

  it('falls back to the env template when the override is undefined', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_OTP_TEMPLATE_ID: 'env-tpl' }),
    );
    await service.sendOtp('9000000001', '123456', 'SMS');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('env-tpl');
  });

  it('falls back to the env template when the override is an empty / whitespace string', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_OTP_TEMPLATE_ID: 'env-tpl' }),
    );
    await service.sendOtp('9000000001', '123456', 'SMS', '   ');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).template_id).toBe('env-tpl');
  });

  it('FIXED_OTP bypass short-circuits BEFORE fetch, even with an override', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    // isFixedOtpAllowed() is true under the test NODE_ENV; a non-empty FIXED_OTP => bypass.
    const service = new Msg91Service(
      makeConfig({ MSG91_AUTH_KEY: 'key-123', MSG91_OTP_TEMPLATE_ID: 'env-tpl', FIXED_OTP: '123456' }),
    );
    await expect(service.sendOtp('9000000001', '123456', 'SMS', 'tenant-tpl')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing-authKey dev bypass short-circuits BEFORE fetch, even with an override', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_OTP_TEMPLATE_ID: 'env-tpl' })); // no authKey
    await expect(service.sendOtp('9000000001', '123456', 'SMS', 'tenant-tpl')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Covers Msg91Service.sendEmail — the MSG91 SMTP RELAY path (Domain Settings → SMTP
// Integration) used by the report runner. MSG91's v5 email HTTP API is template-only and
// can't carry our rich report HTML, so email sends over SMTP (nodemailer). Same dev-bypass
// convention (missing credential → log + return, no throw), plus the relay config + from
// derivation and the SMTP-failure throw.
describe('Msg91Service.sendEmail (SMTP relay)', () => {
  const createTransport = nodemailer.createTransport as unknown as jest.Mock;
  let sendMail: jest.Mock;
  let close: jest.Mock;

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: '<id@smtp.mailer91.com>' });
    close = jest.fn();
    createTransport.mockReturnValue({ sendMail, close });
  });
  afterEach(() => jest.clearAllMocks());

  it('dev bypass: no MSG91_SMTP_PASS → logs + returns WITHOUT connecting', async () => {
    const service = new Msg91Service(makeConfig({})); // no SMTP password
    await expect(
      service.sendEmail({ to: ['a@b.com'], subject: 'Daily report', html: '<p>hi</p>' }),
    ).resolves.toBeUndefined();

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('no-op (no connection) when the recipient list is empty', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' }));
    await expect(
      service.sendEmail({ to: [], subject: 'Daily report', html: '<p>hi</p>' }),
    ).resolves.toBeUndefined();

    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends over SMTP with the default relay config + from address, then closes', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'secret-pw' }));
    await service.sendEmail({
      to: ['owner@acme.com', 'ops@acme.com'],
      subject: 'Weekly summary',
      html: '<h1>Report</h1>',
    });

    // Default MSG91 relay for the verified notify.gifsy.in domain, port 587 (STARTTLS).
    expect(createTransport).toHaveBeenCalledTimes(1);
    const cfg = createTransport.mock.calls[0][0];
    expect(cfg.host).toBe('smtp.mailer91.com');
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
    expect(cfg.auth).toEqual({ user: 'emailer@notify.gifsy.in', pass: 'secret-pw' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toEqual({
      from: 'reports@notify.gifsy.in',
      to: ['owner@acme.com', 'ops@acme.com'],
      subject: 'Weekly summary',
      html: '<h1>Report</h1>',
    });
    expect(close).toHaveBeenCalled();
  });

  it('throws a clear error when the SMTP send fails (and still closes the transport)', async () => {
    sendMail.mockRejectedValue(new Error('535 auth failed'));
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' }));
    await expect(
      service.sendEmail({ to: ['a@b.com'], subject: 'Daily report', html: '<p>hi</p>' }),
    ).rejects.toThrow(/535 auth failed/);
    expect(close).toHaveBeenCalled();
  });

  it('honors REPORTS_FROM_EMAIL + SMTP host/port/user overrides (465 → implicit TLS)', async () => {
    const service = new Msg91Service(
      makeConfig({
        MSG91_SMTP_PASS: 'pw',
        REPORTS_FROM_EMAIL: 'noreply@notify.gifsy.in',
        MSG91_SMTP_HOST: 'smtp.example.com',
        MSG91_SMTP_PORT: '465',
        MSG91_SMTP_USER: 'custom@notify.gifsy.in',
      }),
    );
    await service.sendEmail({ to: ['a@b.com'], subject: 'Daily report', html: '<p>hi</p>' });

    const cfg = createTransport.mock.calls[0][0];
    expect(cfg.host).toBe('smtp.example.com');
    expect(cfg.port).toBe(465);
    expect(cfg.secure).toBe(true); // 465 = implicit TLS
    expect(cfg.auth.user).toBe('custom@notify.gifsy.in');
    expect(sendMail.mock.calls[0][0].from).toBe('noreply@notify.gifsy.in');
  });
});
