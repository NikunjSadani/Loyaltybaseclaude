// Unit tests for Msg91Service.sendWhatsappTemplate — the MSG91 v5 bulk WhatsApp
// template path. Covers the request URL + body shape, the body_N variable mapping,
// the missing-authKey dev bypass, and the failure throws.
// Run: npx jest src/notifications/msg91.service.spec.ts

import { Logger } from '@nestjs/common';
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
    ).resolves.toEqual({ requestId: null });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guard: a non-10-digit recipient (already-prefixed / +91 / short) is dropped, no fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    for (const bad of ['919830011252', '+919830011252', '98300', '98300112ab']) {
      await expect(
        service.sendWhatsappTemplate(bad, 'deoleo_kyc_approval', ['Owner', 'Program']),
      ).resolves.toEqual({ requestId: null });
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

  it('a non-string provider message (object / null) never throws in the scrub; secrets withhold the whole reason', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    // Object message → JSON-stringified into the reason.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ type: 'error', message: { errors: ['bad param'] } }),
    }) as unknown as typeof fetch;
    await expect(
      service.sendWhatsappTemplate('9000000001', 'voucher_code', ['A', 'B'], { secretValues: ['482913'] }),
    ).rejects.toThrow(/bad param/);
    // null message → falls back to the HTTP status.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 502, json: async () => ({ type: 'error', message: null }),
    }) as unknown as typeof fetch;
    await expect(
      service.sendWhatsappTemplate('9000000001', 'voucher_code', ['A', 'B'], { secretValues: ['482913'] }),
    ).rejects.toThrow(/HTTP 502/);
    // An object message echoing the PIN → the whole reason is withheld (never the PIN).
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ type: 'error', message: { value: 'PIN: 482913' } }),
    }) as unknown as typeof fetch;
    const err = await service
      .sendWhatsappTemplate('9000000001', 'voucher_code', ['A', 'B'], { secretValues: ['482913'] })
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/details withheld/);
    expect(String(err)).not.toContain('482913');
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

  it('passes crqid on the recipient and returns MSG91 request id from the response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', request_id: 'req-abc-123' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    const result = await service.sendSms('9000000001', 'dlt-tpl-1', { a: 'b' }, { crqid: 'crq-1' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients).toEqual([{ mobiles: '919000000001', a: 'b', crqid: 'crq-1' }]);
    expect(result).toEqual({ requestId: 'req-abc-123' });
  });

  it('returns { requestId: null } when the response carries no id', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'success' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', {})).resolves.toEqual({
      requestId: null,
    });
  });

  it('dev bypass: no authKey → logs + returns WITHOUT calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({})); // MSG91_AUTH_KEY undefined
    await expect(service.sendSms('9000000001', 'dlt-tpl-1', { a: 'b' })).resolves.toEqual({
      requestId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('guard: a non-10-digit recipient (already-prefixed / +91 / short / non-numeric) is dropped, no fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    for (const bad of ['919830011252', '+919830011252', '98300', '98300112ab']) {
      await expect(service.sendSms(bad, 'dlt-tpl-1', {})).resolves.toEqual({ requestId: null });
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

  it('a provider error echoing a flagged secret is withheld (thrown + logged); the phone is logged as last 4 only', async () => {
    const CODE = '6001220012345678';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'error', message: `invalid var code=${CODE}` }),
    }) as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    const logged: string[] = [];
    jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    const err = await service.sendSms('9000000001', 'dlt-tpl-1', { code: CODE }, { secretValues: [CODE] }).catch((e: Error) => e);
    expect(String(err)).toContain('details withheld');
    expect(String(err)).not.toContain(CODE);
    expect(logged.join(' | ')).not.toContain(CODE);
    expect(logged.join(' | ')).not.toContain('9000000001');
    expect(logged.join(' | ')).toContain('••••0001');
  });

  it('a non-JSON response → a generic reason (HTTP n), never the body snippet', async () => {
    const CODE = '6001220012345678';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError(`Unexpected token '<', "<html>bad ${CODE}" is not valid JSON`);
      },
    }) as unknown as typeof fetch;
    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
    const smsErr = await service.sendSms('9000000001', 'dlt-tpl-1', { code: CODE }).catch((e: Error) => e);
    expect(String(smsErr)).toContain('MSG91 returned a non-JSON response (HTTP 502)');
    expect(String(smsErr)).not.toMatch(/html|not valid JSON/);
    expect(String(smsErr)).not.toContain(CODE);
    const waErr = await service.sendWhatsappTemplate('9000000001', 'voucher_code', [CODE]).catch((e: Error) => e);
    expect(String(waErr)).toContain('MSG91 returned a non-JSON response (HTTP 502)');
    expect(String(waErr)).not.toContain(CODE);
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

  it('returns MSG91 request id from the OTP response body (best-effort)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', request_id: 'otp-req-9876543210abcdef' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendOtp('9000000001', '123456', 'SMS')).resolves.toEqual({
      requestId: 'otp-req-9876543210abcdef',
    });
  });

  it('reads a bare ~24-char request id echoed on the OTP success `message` field', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', message: '3a1f9c7e2b6d4058af12cd34' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendOtp('9000000001', '123456', 'SMS')).resolves.toEqual({
      requestId: '3a1f9c7e2b6d4058af12cd34',
    });
  });

  it('returns { requestId: null } when the OTP response carries no id', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'success' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_AUTH_KEY: 'key-123' }));
    await expect(service.sendOtp('9000000001', '123456', 'SMS')).resolves.toEqual({
      requestId: null,
    });
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
    await expect(service.sendOtp('9000000001', '123456', 'SMS', 'tenant-tpl')).resolves.toEqual({
      requestId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing-authKey dev bypass short-circuits BEFORE fetch, even with an override', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Msg91Service(makeConfig({ MSG91_OTP_TEMPLATE_ID: 'env-tpl' })); // no authKey
    await expect(service.sendOtp('9000000001', '123456', 'SMS', 'tenant-tpl')).resolves.toEqual({
      requestId: null,
    });
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
    ).resolves.toEqual({ skipped: true, accepted: [], rejected: [] });

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('no-op (no connection) when the recipient list is empty', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' }));
    await expect(
      service.sendEmail({ to: [], subject: 'Daily report', html: '<p>hi</p>' }),
    ).resolves.toEqual({ skipped: true, accepted: [], rejected: [] });

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

  it('cc: one message with a real Cc; returns the relay-rejected addresses (partial accept)', async () => {
    sendMail.mockResolvedValue({ messageId: '<x>', accepted: ['a@acme.com'], rejected: ['Bad@acme.com'] });
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'secret-pw' }));
    const res = await service.sendEmail({ to: ['a@acme.com'], cc: ['bad@acme.com'], subject: 'S', html: '<p/>' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toEqual({ from: 'reports@notify.gifsy.in', to: ['a@acme.com'], cc: ['bad@acme.com'], subject: 'S', html: '<p/>' });
    expect(res).toEqual({ skipped: false, accepted: ['a@acme.com'], rejected: ['bad@acme.com'] });
  });

  it('empty cc → no cc key (existing callers unchanged); unconfigured → skipped', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'secret-pw' }));
    await service.sendEmail({ to: ['a@acme.com'], cc: [], subject: 'S', html: '<p/>' });
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('cc');
    const off = new Msg91Service(makeConfig({}));
    expect(await off.sendEmail({ to: ['a@acme.com'], subject: 'S', html: '<p/>' })).toEqual({ skipped: true, accepted: [], rejected: [] });
  });

  it('no text / no attachments (or empty attachments) → the sendMail argument is byte-identical to before', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'secret-pw' }));
    await service.sendEmail({ to: ['a@acme.com'], subject: 'S', html: '<p/>' });
    await service.sendEmail({ to: ['a@acme.com'], cc: ['c@acme.com'], subject: 'S', html: '<p/>', attachments: [] });
    // Exact key set AND order (JSON.stringify is order-sensitive) — what nodemailer receives today.
    expect(JSON.stringify(sendMail.mock.calls[0][0])).toBe(
      JSON.stringify({ from: 'reports@notify.gifsy.in', to: ['a@acme.com'], subject: 'S', html: '<p/>' }),
    );
    expect(JSON.stringify(sendMail.mock.calls[1][0])).toBe(
      JSON.stringify({ from: 'reports@notify.gifsy.in', to: ['a@acme.com'], cc: ['c@acme.com'], subject: 'S', html: '<p/>' }),
    );
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('text');
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('attachments');
  });

  it('text + attachments are passed through to nodemailer unchanged (one message)', async () => {
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'secret-pw' }));
    const content = Buffer.from('xlsx-bytes');
    await service.sendEmail({
      to: ['a@client.com'],
      subject: 'Tracker',
      html: '<p>t</p>',
      text: 'plain',
      attachments: [{ filename: 'T.xlsx', content, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0][0];
    expect(arg).toEqual({
      from: 'reports@notify.gifsy.in',
      to: ['a@client.com'],
      subject: 'Tracker',
      html: '<p>t</p>',
      text: 'plain',
      attachments: [{ filename: 'T.xlsx', content, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
    expect(arg.attachments[0].content).toBe(content); // the same Buffer, not a copy/encoding
  });

  it('throws a clear error when the SMTP send fails (and still closes the transport)', async () => {
    sendMail.mockRejectedValue(new Error('535 auth failed'));
    const service = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' }));
    await expect(
      service.sendEmail({ to: ['a@b.com'], subject: 'Daily report', html: '<p>hi</p>' }),
    ).rejects.toThrow(/535 auth failed/);
    expect(close).toHaveBeenCalled();
  });

  describe('ambiguous delivery (connection lost AFTER the message was handed to the relay)', () => {
    const failAfter = (commands: string[], err: Error & { code?: string }) => {
      sendMail.mockImplementation(async () => {
        const cfg = createTransport.mock.calls[createTransport.mock.calls.length - 1][0];
        for (const c of commands) cfg.logger.debug({ tnx: 'client' }, c);
        throw err;
      });
    };
    const send = () =>
      new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' })).sendEmail({ to: ['a@b.com'], subject: 'S', html: '<p/>', detectAmbiguousDelivery: true });

    it('OPT-IN only: an existing-style call gets EXACTLY the previous transport options, sendMail args and a plain Error', async () => {
      const svc = new Msg91Service(makeConfig({ MSG91_SMTP_PASS: 'pw' }));
      await svc.sendEmail({ to: ['a@b.com'], subject: 'S', html: '<p/>' });
      expect(createTransport.mock.calls[0][0]).toStrictEqual({
        host: 'smtp.mailer91.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'emailer@notify.gifsy.in', pass: 'pw' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      expect(JSON.stringify(sendMail.mock.calls[0][0])).toBe(JSON.stringify({ from: 'reports@notify.gifsy.in', to: ['a@b.com'], subject: 'S', html: '<p/>' }));

      sendMail.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
      const e = await svc.sendEmail({ to: ['a@b.com'], subject: 'S', html: '<p/>' }).catch((x) => x);
      expect(e.constructor).toBe(Error);
      expect(e.message).toBe('Failed to send email "S": Timeout');
      expect(e).not.toHaveProperty('deliveryAmbiguous');
      expect(createTransport.mock.calls[1][0]).not.toHaveProperty('logger');
      expect(createTransport.mock.calls[1][0]).not.toHaveProperty('transactionLog');
    });

    it('timeout after DATA → deliveryAmbiguous=true (same message as before)', async () => {
      failAfter(['EHLO x', 'MAIL FROM:<r@n>', 'RCPT TO:<a@b.com>', 'DATA'], Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
      const e = await send().catch((x) => x);
      expect(e.message).toBe('Failed to send email "S": Timeout');
      expect(e.deliveryAmbiguous).toBe(true);
    });

    it('timeout BEFORE DATA → not ambiguous (safe to retry)', async () => {
      failAfter(['EHLO x', 'MAIL FROM:<r@n>'], Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
      const e = await send().catch((x) => x);
      expect(e.deliveryAmbiguous).toBe(false);
    });

    it('the relay explicitly rejecting the message after DATA (EMESSAGE / EENVELOPE) → not ambiguous', async () => {
      failAfter(['DATA'], Object.assign(new Error('Message failed'), { code: 'EMESSAGE' }));
      expect((await send().catch((x) => x)).deliveryAmbiguous).toBe(false);
      failAfter(['DATA'], Object.assign(new Error('Data command failed'), { code: 'EENVELOPE' }));
      expect((await send().catch((x) => x)).deliveryAmbiguous).toBe(false);
    });

    it('opted in: the transport logs only the command lines (transactionLog), never the message body', () => {
      return send().then(() => {
        const cfg = createTransport.mock.calls[0][0];
        expect(cfg.transactionLog).toBe(true);
        expect(cfg.debug).toBeFalsy();
      });
    });
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
