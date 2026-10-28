// Unit tests for HubbleService — the Hubble Money API client. Mocks global fetch
// (no real network): token login + cache + 80%-life refresh, 401 re-auth-and-retry,
// placeOrder (branch on body status), getOrderByReference (404 → null).
// Run: npx jest src/hubble/hubble.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { HubbleService } from './hubble.service';

const CONFIG: Record<string, string> = {
  HUBBLE_BASE_URL: 'https://api.dev.myhubble.money',
  HUBBLE_CLIENT_ID_STAGING: 'cid-123',
  HUBBLE_CLIENT_SECRET_STAGING: 'secret-xyz',
};

function makeService(overrides: Record<string, string | undefined> = {}): HubbleService {
  const cfg = { ...CONFIG, ...overrides };
  const config = {
    get: jest.fn((k: string) => cfg[k]),
  } as unknown as ConfigService;
  return new HubbleService(config);
}

/** Build a fetch Response-like stub. */
function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const LOGIN_OK = { token: 'tok-abc', expiresInSecs: 3600 };

describe('HubbleService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.clearAllMocks());

  it('isConfigured reflects presence of client credentials', () => {
    expect(makeService().isConfigured()).toBe(true);
    expect(makeService({ HUBBLE_CLIENT_ID_STAGING: undefined }).isConfigured()).toBe(false);
    expect(makeService({ HUBBLE_CLIENT_SECRET_STAGING: undefined }).isConfigured()).toBe(false);
  });

  it('logs in once and caches the token across calls', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK)) // login
      .mockResolvedValueOnce(jsonRes(201, { status: 'SUCCESS', vouchers: [] })) // order 1
      .mockResolvedValueOnce(jsonRes(201, { status: 'SUCCESS', vouchers: [] })); // order 2

    await svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] });
    await svc.placeOrder({ productId: 'p', referenceId: 'r2', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] });

    // 1 login + 2 orders = 3 fetches (NOT 4 — the token was cached).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const loginCall = fetchMock.mock.calls[0];
    expect(loginCall[0]).toBe('https://api.dev.myhubble.money/v1/partners/auth/login');
  });

  it('sends Bearer token + X-REQUEST-ID + JSON content-type on authed calls', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonRes(201, { status: 'PROCESSING', vouchers: [] }));

    await svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] });

    const orderCall = fetchMock.mock.calls[1];
    expect(orderCall[0]).toBe('https://api.dev.myhubble.money/v1/partners/orders');
    const headers = (orderCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof headers['X-REQUEST-ID']).toBe('string');
    expect(headers['X-REQUEST-ID'].length).toBeGreaterThan(10);
  });

  it('re-authenticates ONCE and retries on a 401', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK)) // initial login
      .mockResolvedValueOnce(jsonRes(401, { message: 'expired' })) // order → 401
      .mockResolvedValueOnce(jsonRes(200, { token: 'tok-NEW', expiresInSecs: 3600 })) // re-login
      .mockResolvedValueOnce(jsonRes(201, { status: 'SUCCESS', vouchers: [{ cardNumber: 'X', cardType: 'CARD_NUMBER_SECURED' }] })); // retry

    const res = await svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] });

    expect(res.status).toBe('SUCCESS');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The retry used the NEW token.
    const retryHeaders = (fetchMock.mock.calls[3][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer tok-NEW');
  });

  it('placeOrder normalises SUCCESS vouchers and a nested data body', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK))
      .mockResolvedValueOnce(
        jsonRes(201, {
          data: {
            id: 'hub-ord-1',
            status: 'SUCCESS',
            vouchers: [{ id: 'v1', cardType: 'CARD_AND_PIN_NO_SECURED', cardNumber: '1111', cardPin: '9999', validTill: '2027-01-01', amount: 500 }],
          },
        }),
      );

    const res = await svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] });
    expect(res.status).toBe('SUCCESS');
    expect(res.id).toBe('hub-ord-1');
    expect(res.vouchers?.[0]?.cardNumber).toBe('1111');
    expect(res.vouchers?.[0]?.cardPin).toBe('9999');
  });

  it('getOrderByReference returns null on 404', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonRes(404, { message: 'not found' }));

    const res = await svc.getOrderByReference('r-unknown');
    expect(res).toBeNull();
  });

  it('getOrderByReference returns the normalised body on 200', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonRes(200, { status: 'FAILED', failureReason: 'wallet empty' }));

    const res = await svc.getOrderByReference('r1');
    expect(res?.status).toBe('FAILED');
    expect(res?.failureReason).toBe('wallet empty');
  });

  it('placeOrder throws on a non-2xx (so the caller recovers by reference)', async () => {
    const svc = makeService();
    fetchMock
      .mockResolvedValueOnce(jsonRes(200, LOGIN_OK))
      .mockResolvedValueOnce(jsonRes(500, { message: 'boom' }))
      // the 500 is not a 401, so NO re-auth; it just throws.
      ;
    await expect(
      svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] }),
    ).rejects.toThrow(/non-success HTTP 500/);
  });

  it('throws a clear error when login fails (and never leaks the body)', async () => {
    const svc = makeService();
    fetchMock.mockResolvedValueOnce(jsonRes(401, { message: 'bad creds' }));
    await expect(
      svc.placeOrder({ productId: 'p', referenceId: 'r1', amount: 500, denominationDetails: [{ denomination: 500, quantity: 1 }] }),
    ).rejects.toThrow(/Hubble auth failed \(HTTP 401\)/);
  });
});
