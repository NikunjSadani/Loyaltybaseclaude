import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  urlBase64ToUint8Array,
  subscribeToPush,
  unsubscribeFromPush,
} from '../push';

// A short, known base64url VAPID-style key for round-trip assertions.
const SAMPLE_KEY = 'BConrU8-';

function makeSubscription(overrides: {
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  unsubscribe?: () => Promise<boolean>;
} = {}) {
  const endpoint = overrides.endpoint ?? 'https://push.example/ep-123';
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: {
        p256dh: overrides.p256dh ?? 'P256DH_KEY',
        auth: overrides.auth ?? 'AUTH_KEY',
      },
    }),
    unsubscribe: overrides.unsubscribe ?? vi.fn().mockResolvedValue(true),
  };
}

// Wire up a registered SW: `.ready` (used by subscribe) AND getRegistration()
// (used by unsubscribe) both resolve to a registration with the given pushManager.
function stubServiceWorker(pushManager: unknown) {
  const registration = { pushManager };
  vi.stubGlobal('navigator', {
    userAgent: 'TestAgent/1.0',
    serviceWorker: {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
}

// No SW registered: getRegistration() resolves undefined immediately (the default
// all-flags-OFF state). The regression guard for the logout-hang blocker.
function stubNoServiceWorker() {
  vi.stubGlobal('navigator', {
    userAgent: 'TestAgent/1.0',
    serviceWorker: {
      // .ready intentionally a never-resolving promise — unsubscribe must NOT await it.
      ready: new Promise(() => {}),
      getRegistration: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function envelope(publicKey: string) {
  return {
    ok: true,
    json: async () => ({ success: true, data: { publicKey } }),
  };
}

describe('urlBase64ToUint8Array', () => {
  it('decodes plain base64url to the right bytes', () => {
    // "AQID" (no url-special chars, no padding needed) => [1, 2, 3].
    const out = urlBase64ToUint8Array('AQID');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('maps - _ to + / and pads correctly', () => {
    // base64url "-_8" => standard "+/8=" => bytes [0xFB, 0xFF].
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
  });
});

describe('subscribeToPush', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { PushManager: function () {} });
    vi.stubGlobal('Notification', { permission: 'granted' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the correct subscribe body shape (new subscription)', async () => {
    const subscription = makeSubscription();
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const getSubscription = vi.fn().mockResolvedValue(null);
    stubServiceWorker({ getSubscription, subscribe });
    // re-stub navigator's userAgent is set above; keep it.

    const fetchMock = vi
      .fn()
      // 1) vapid-public-key
      .mockResolvedValueOnce(envelope('BReal_Vapid_Key'))
      // 2) subscribe POST
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'x' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribeToPush();
    expect(result).toBe('subscribed');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/push/vapid-public-key');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      endpoint: 'https://push.example/ep-123',
      keys: { p256dh: 'P256DH_KEY', auth: 'AUTH_KEY' },
      userAgent: 'TestAgent/1.0',
    });
    // Reused-creation gate: subscribe() called because getSubscription was null.
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing subscription without calling subscribe()', async () => {
    const subscription = makeSubscription({ endpoint: 'https://push.example/existing' });
    const subscribe = vi.fn();
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    stubServiceWorker({ getSubscription, subscribe });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope('BReal_Vapid_Key'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'x' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribeToPush();
    expect(result).toBe('subscribed');
    expect(subscribe).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).endpoint).toBe(
      'https://push.example/existing',
    );
  });

  it('returns "unavailable" and does NOT POST when the VAPID key is empty', async () => {
    const subscribe = vi.fn();
    const getSubscription = vi.fn().mockResolvedValue(null);
    stubServiceWorker({ getSubscription, subscribe });

    const fetchMock = vi.fn().mockResolvedValueOnce(envelope(''));
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribeToPush();
    expect(result).toBe('unavailable');
    // Only the vapid-key GET happened; no subscribe POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('returns "denied" when notification permission is denied (no fetch)', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    stubServiceWorker({ getSubscription: vi.fn(), subscribe: vi.fn() });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribeToPush();
    expect(result).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "unavailable" when PushManager is missing', async () => {
    vi.stubGlobal('window', {});
    const result = await subscribeToPush();
    expect(result).toBe('unavailable');
  });
});

describe('unsubscribeFromPush', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs {endpoint} then calls subscription.unsubscribe()', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = makeSubscription({
      endpoint: 'https://push.example/bye',
      unsubscribe,
    });
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    stubServiceWorker({ getSubscription });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await unsubscribeFromPush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/push/unsubscribe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://push.example/bye' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does nothing (no throw) when there is no subscription', async () => {
    const getSubscription = vi.fn().mockResolvedValue(null);
    stubServiceWorker({ getSubscription });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(unsubscribeFromPush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows backend errors and still unsubscribes locally', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = makeSubscription({ unsubscribe });
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    stubServiceWorker({ getSubscription });

    const fetchMock = vi.fn().mockRejectedValue(new Error('network'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(unsubscribeFromPush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resolves immediately when NO service worker is registered (no logout hang)', async () => {
    // Regression: must use getRegistration() (resolves undefined), NOT serviceWorker.ready
    // (never resolves with no SW) — else logout would hang forever in the all-flags-OFF state.
    stubNoServiceWorker();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(unsubscribeFromPush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
