// -----------------------------------------------------------------------------
// Web Push subscribe helpers — PWA phase F5 (FE glue). SHIPPED DISABLED.
//
// Pure, React-free helpers used by PushSubscriptionManager (the gated UI) and by
// the logout flow (unsubscribeFromPush). The service worker (`/sw.js`) already
// owns the `push` + `notificationclick` handlers; this module only manages the
// browser PushSubscription and syncs it with the backend.
//
// Backend contract (do NOT change):
//   GET  /api/push/vapid-public-key -> { success, data: { publicKey } }
//        publicKey === '' means VAPID isn't configured => push unavailable.
//   POST /api/push/subscribe   { endpoint, keys:{p256dh,auth}, userAgent? }
//   POST /api/push/unsubscribe { endpoint }
// All three are authenticated by the httpOnly cookie that the same-origin
// `/api/*` edge proxy turns into a Bearer — so we use RELATIVE urls and send NO
// Authorization header.
// -----------------------------------------------------------------------------

export type SubscribeResult = 'subscribed' | 'unavailable' | 'denied' | 'error';

/**
 * Convert a base64url-encoded VAPID public key into the Uint8Array that
 * PushManager.subscribe() expects as `applicationServerKey`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  // Back the view with a concrete ArrayBuffer (not the generic ArrayBufferLike) so
  // the result satisfies PushManager.subscribe()'s `BufferSource` applicationServerKey.
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Fetch the platform VAPID public key. Returns '' on any error or when VAPID is
 * not configured server-side (empty publicKey) — the caller treats '' as
 * "push unavailable, do nothing".
 */
export async function getVapidPublicKey(): Promise<string> {
  try {
    const res = await fetch('/api/push/vapid-public-key', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return '';
    const body = (await res.json()) as { data?: { publicKey?: string } };
    return body?.data?.publicKey ?? '';
  } catch {
    return '';
  }
}

/**
 * Subscribe this browser to Web Push and register the subscription with the
 * backend. Idempotent: reuses an existing PushSubscription if present, and the
 * backend upserts by endpoint, so calling it repeatedly is safe.
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  // Capability gate.
  if (
    typeof navigator === 'undefined' ||
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return 'unavailable';
  }

  // Respect a hard denial — never re-prompt or attempt to subscribe.
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'denied'
  ) {
    return 'denied';
  }

  try {
    const publicKey = await getVapidPublicKey();
    if (!publicKey) return 'unavailable';

    const reg = await navigator.serviceWorker.ready;

    // Reuse an existing subscription; only create one when none exists.
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const json = subscription.toJSON();
    const endpoint = json.endpoint ?? subscription.endpoint;
    const p256dh = json.keys?.p256dh ?? '';
    const auth = json.keys?.auth ?? '';

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        keys: { p256dh, auth },
        userAgent: navigator.userAgent,
      }),
    });
    if (!res.ok) return 'error';
    return 'subscribed';
  } catch {
    return 'error';
  }
}

/**
 * Best-effort tear-down for logout: tell the backend to drop the subscription,
 * then unsubscribe the browser. Swallows every error — logout must never break.
 */
export async function unsubscribeFromPush(): Promise<void> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator)
    ) {
      return;
    }
    // Use getRegistration() (resolves immediately, undefined when none) — NOT
    // serviceWorker.ready, which never resolves if no SW is registered (the
    // default all-flags-OFF state) and would hang logout forever.
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    const endpoint = subscription.endpoint;
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
    } catch {
      /* network/backend error — still unsubscribe locally below */
    }
    await subscription.unsubscribe();
  } catch {
    /* nothing to tear down / unsupported — ignore */
  }
}
