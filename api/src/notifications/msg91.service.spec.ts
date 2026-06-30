// Unit tests for Msg91Service.sendWhatsappTemplate — the MSG91 v5 bulk WhatsApp
// template path. Covers the request URL + body shape, the body_N variable mapping,
// the missing-authKey dev bypass, and the failure throws.
// Run: npx jest src/notifications/msg91.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { Msg91Service } from './msg91.service';

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
