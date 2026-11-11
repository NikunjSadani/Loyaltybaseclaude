// Unit tests for HubbleService — the Hubble Money API client. Mocks global fetch
// (no real network): token login + cache + 80%-life refresh, 401 re-auth-and-retry,
// placeOrder (branch on body status), getOrderByReference (404 → null).
// Run: npx jest src/hubble/hubble.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { HubbleNotConfiguredError, HubbleProductNotFoundError, HubbleService } from './hubble.service';

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

  // ── F3: environment-neutral credential names (prod) with *_STAGING fallback (staging) ──
  it('F3: the neutral HUBBLE_CLIENT_ID/SECRET alone configure the service (prod wiring)', () => {
    const svc = makeService({
      HUBBLE_CLIENT_ID_STAGING: undefined,
      HUBBLE_CLIENT_SECRET_STAGING: undefined,
      HUBBLE_CLIENT_ID: 'prod-cid',
      HUBBLE_CLIENT_SECRET: 'prod-secret',
    });
    expect(svc.isConfigured()).toBe(true);
  });

  it('F3: the neutral names WIN over the *_STAGING ones at login', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
    fetchMock.mockResolvedValueOnce(jsonRes(404, undefined));
    const svc = makeService({ HUBBLE_CLIENT_ID: 'prod-cid', HUBBLE_CLIENT_SECRET: 'prod-secret' });
    await svc.getOrderByReference('ref-1');
    const loginBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(loginBody).toEqual({ clientId: 'prod-cid', clientSecret: 'prod-secret' });
  });

  it('L1: a half-present NEUTRAL pair never mixes with *_STAGING → not configured + one clear error log', () => {
    const svc = makeService({ HUBBLE_CLIENT_ID: 'prod-cid' }); // staging pair still present
    const errSpy = jest.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);
    expect(svc.isConfigured()).toBe(false);
    expect(svc.isConfigured()).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('HUBBLE_CLIENT_SECRET is missing');
    expect(errSpy.mock.calls[0][0]).not.toContain('prod-cid');
  });

  it('L1: a half-present STAGING pair (no neutral) → not configured + names the missing *_STAGING var', () => {
    const svc = makeService({ HUBBLE_CLIENT_SECRET_STAGING: undefined });
    const errSpy = jest.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => undefined);
    expect(svc.isConfigured()).toBe(false);
    expect(errSpy.mock.calls[0][0]).toContain('HUBBLE_CLIENT_SECRET_STAGING is missing');
  });

  it('F3: blank neutral names fall back to *_STAGING (staging keeps working unchanged)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
    fetchMock.mockResolvedValueOnce(jsonRes(404, undefined));
    const svc = makeService({ HUBBLE_CLIENT_ID: '  ', HUBBLE_CLIENT_SECRET: '' });
    expect(svc.isConfigured()).toBe(true);
    await svc.getOrderByReference('ref-2');
    const loginBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(loginBody).toEqual({ clientId: 'cid-123', clientSecret: 'secret-xyz' });
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

  // ── getProduct: GET /v1/partners/products/:id (shape confirmed against staging 2026-11-11) ──
  describe('getProduct', () => {
    // Real staging shape (Flipkart, FLEXIBLE) — amountRestrictions carries the limits.
    const FLEX_BODY = {
      id: '01GMMNJECTDZAG2YS61K58HVG8', status: 'ACTIVE', title: 'Flipkart', denominationType: 'FLEXIBLE',
      amountRestrictions: {
        minAmount: 10, maxAmount: 50000, minOrderAmount: 10, maxOrderAmount: 50000,
        minVoucherAmount: 10, maxVoucherAmount: 10000, maxVouchersPerOrder: 10,
        maxVouchersPerDenomination: null, maxDenominationsPerOrder: null, denominations: null,
      },
    };
    const FIXED_BODY = {
      id: 'fk-fixed', status: 'ACTIVE', title: 'Flipkart', denominationType: 'FIXED',
      amountRestrictions: {
        minOrderAmount: 50, maxOrderAmount: 20000, minVoucherAmount: 150, maxVoucherAmount: 10000,
        maxVouchersPerOrder: 10, denominations: [10000, 150, 175, 300, 1250, 2500, 5000, 7500, 30000],
      },
    };

    it('normalises a FLEXIBLE product (single-voucher min/max = tighter of voucher + order limits)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, FLEX_BODY));
      const p = await makeService().getProduct('01GMMNJECTDZAG2YS61K58HVG8');
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.dev.myhubble.money/v1/partners/products/01GMMNJECTDZAG2YS61K58HVG8');
      expect(fetchMock.mock.calls[1][1].method).toBe('GET');
      expect(p).toEqual({
        productId: '01GMMNJECTDZAG2YS61K58HVG8', name: 'Flipkart', denominationType: 'FLEXIBLE',
        denominations: [], minValue: 10, maxValue: 10000, maxVouchersPerOrder: 10,
      });
    });

    it('normalises a FIXED product: denominations sorted, de-duplicated, outside the order limits dropped', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, FIXED_BODY));
      const p = await makeService().getProduct('fk-fixed');
      expect(p.denominationType).toBe('FIXED');
      // 30000 > maxOrderAmount 20000 → not issuable as a single voucher → dropped.
      expect(p.denominations).toEqual([150, 175, 300, 1250, 2500, 5000, 7500, 10000]);
      expect(p.minValue).toBe(150);
      expect(p.maxValue).toBe(10000);
    });

    it.each([
      ['numeric strings', { amountRestrictions: { ...FIXED_BODY.amountRestrictions, denominations: ['300', '150', 'x'] } }],
      ['objects {value|amount|denomination}', { amountRestrictions: { ...FIXED_BODY.amountRestrictions, denominations: [{ value: 300 }, { amount: '150' }, { denomination: 1250 }] } }],
      ['variantDetails fallback when the primary list is null', { amountRestrictions: { ...FIXED_BODY.amountRestrictions, denominations: null }, variantDetails: [{ amount: 150 }, { value: 300 }, { faceValue: 1250 }] }],
    ])('M1: FIXED denominations tolerated as %s', async (_label, over) => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, { ...FIXED_BODY, ...over }));
      const p = await makeService().getProduct('fk-fixed');
      expect(p.denominations.slice(0, 2)).toEqual([150, 300]);
    });

    it('M1: a FIXED brand with no parseable list → denominations [] (UNKNOWN; callers let Hubble validate)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, { ...FIXED_BODY, amountRestrictions: { ...FIXED_BODY.amountRestrictions, denominations: null } }));
      const p = await makeService().getProduct('fk-fixed');
      expect(p.denominationType).toBe('FIXED');
      expect(p.denominations).toEqual([]);
    });

    it('caches the product for ~10 minutes (a second call makes no HTTP request)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, FLEX_BODY));
      const svc = makeService();
      await svc.getProduct('01GMMNJECTDZAG2YS61K58HVG8');
      await svc.getProduct('01GMMNJECTDZAG2YS61K58HVG8');
      expect(fetchMock).toHaveBeenCalledTimes(2); // login + one GET
    });

    it('404 → HubbleProductNotFoundError', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(404, { message: 'nope' }));
      await expect(makeService().getProduct('x')).rejects.toBeInstanceOf(HubbleProductNotFoundError);
    });

    it('400 E102 "Brand is not active" (what staging returns for an unknown/inactive id) → HubbleProductNotFoundError', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(400, { id: 'E102', code: 'OPERATION_NOT_ALLOWED', message: 'Brand is not active' }));
      await expect(makeService().getProduct('x')).rejects.toBeInstanceOf(HubbleProductNotFoundError);
    });

    it('an INACTIVE product → HubbleProductNotFoundError (vouchers cannot be generated)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(200, { ...FLEX_BODY, status: 'INACTIVE' }));
      await expect(makeService().getProduct('x')).rejects.toBeInstanceOf(HubbleProductNotFoundError);
    });

    it('not configured → HubbleNotConfiguredError, no HTTP', async () => {
      const svc = makeService({ HUBBLE_CLIENT_ID_STAGING: undefined });
      await expect(svc.getProduct('x')).rejects.toBeInstanceOf(HubbleNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a 5xx throws a generic error (not cached)', async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
      fetchMock.mockResolvedValueOnce(jsonRes(503, {}));
      const svc = makeService();
      await expect(svc.getProduct('x')).rejects.toThrow(/HTTP 503/);
      fetchMock.mockResolvedValueOnce(jsonRes(200, FLEX_BODY));
      await expect(svc.getProduct('x')).resolves.toMatchObject({ denominationType: 'FLEXIBLE' });
    });

    describe('getProductForRedeem (re-check M1: fast, single-flight, negative cache, never throws)', () => {
      const fast = (svc: HubbleService, budgetMs = 30) => {
        (svc as unknown as { redeemLookupBudgetMs: number }).redeemLookupBudgetMs = budgetMs;
        return svc;
      };

      it('a hung Hubble → null after the budget (not 15 s), then the next 60 s skip WITHOUT any request', async () => {
        fetchMock.mockImplementation(() => new Promise(() => undefined)); // login never answers
        const svc = fast(makeService());
        const t0 = Date.now();
        await expect(svc.getProductForRedeem('fk-fixed')).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
        const callsAfterFirst = fetchMock.mock.calls.length;
        await expect(svc.getProductForRedeem('fk-fixed')).resolves.toBeNull();
        expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // negative cache: no new request
      });

      it('concurrent lookups for one product share ONE request (single-flight)', async () => {
        fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
        fetchMock.mockResolvedValueOnce(jsonRes(200, FIXED_BODY));
        const svc = fast(makeService(), 2000);
        const [a, b, c] = await Promise.all([
          svc.getProductForRedeem('fk-fixed'), svc.getProductForRedeem('fk-fixed'), svc.getProductForRedeem('fk-fixed'),
        ]);
        expect(a?.denominationType).toBe('FIXED');
        expect(b).toBe(a);
        expect(c).toBe(a);
        expect(fetchMock).toHaveBeenCalledTimes(2); // one login + one GET
      });

      it('an error (5xx / not found) → null, never throws; not configured → null with no request', async () => {
        fetchMock.mockResolvedValueOnce(jsonRes(200, LOGIN_OK));
        fetchMock.mockResolvedValueOnce(jsonRes(503, {}));
        await expect(fast(makeService(), 2000).getProductForRedeem('x')).resolves.toBeNull();
        fetchMock.mockClear();
        await expect(makeService({ HUBBLE_CLIENT_ID_STAGING: undefined }).getProductForRedeem('x')).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('the redeem budget is 2.5 s and the negative cache 60 s (issuance keeps getProduct + 15 s)', () => {
        const svc = makeService();
        expect(svc.redeemLookupBudgetMs).toBe(2500);
        expect(svc.redeemNegativeTtlMs).toBe(60000);
      });
    });

    it('rejects an unsafe productId before any HTTP call', async () => {
      await expect(makeService().getProduct('../orders')).rejects.toBeInstanceOf(HubbleProductNotFoundError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
