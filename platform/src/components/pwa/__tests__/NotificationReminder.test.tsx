import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Bajaj "turn on notifications" reminder (owner 2026-11-19), driven through PushSubscriptionManager exactly as the
// root layout mounts it.

const subscribeToPush = vi.fn().mockResolvedValue('subscribed');
vi.mock('@/lib/pwa/push', () => ({
  subscribeToPush: (...a: unknown[]) => subscribeToPush(...a),
}));

// Device detection is the location gate's — control it directly.
let platform: 'android' | 'ios-safari' | 'ios-app' | 'desktop' = 'android';
vi.mock('@/lib/location-gate', () => ({
  currentLocationPlatform: () => platform,
}));
let inSafari = true;
vi.mock('@/lib/pwa/platform-detect', () => ({
  isIosSafari: () => inSafari,
  isStandalone: () => platform === 'ios-app',
}));

import PushSubscriptionManager, {
  AUTO_ASK_TIMEOUT_MS,
  REMINDER_SEEN_AFTER_MS,
  REMINDER_SESSION_KEY,
} from '../PushSubscriptionManager';
import InstallPrompt from '../InstallPrompt';

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  iphone16_3: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  ipadDesktopNoVersion: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

/** A fake Notification whose permission really changes when requestPermission resolves (like a browser). */
function stubNotification(permission: NotificationPermission, requestResult: NotificationPermission = permission) {
  const fake = {
    permission,
    requestPermission: vi.fn(async (): Promise<NotificationPermission> => {
      fake.permission = requestResult;
      return requestResult;
    }),
  };
  vi.stubGlobal('Notification', fake);
  return fake;
}

/** GET /api/auth/me — a live session for `id`, or a dead one (401) when id is null. */
const meFetch = vi.fn();
function mockSession(id: string | null) {
  meFetch.mockImplementation(async () =>
    id
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { role: 'SALES_REP', user: { id } } }) }
      : { ok: false, status: 401, json: async () => ({ success: false }) },
  );
}

function enablePushSupport() {
  if (!('serviceWorker' in navigator)) {
    Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve({}) }, configurable: true });
  }
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
}

function disablePushSupport() {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
}

function setUa(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
}

const renderBajaj = () => render(<PushSubscriptionManager tenantSlug="bajaj" appName="Bajaj Consumer Care Ltd Sales" />);

describe('Bajaj notification reminder', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllEnvs();
    subscribeToPush.mockReset();
    subscribeToPush.mockResolvedValue('subscribed');
    meFetch.mockReset();
    mockSession('u-1');
    vi.stubGlobal('fetch', meFetch);
    window.history.pushState({}, '', '/sales/dashboard');
    enablePushSupport();
    platform = 'android';
    inSafari = true;
    setUa(UA.android);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.overflow = '';
  });

  it('confirms the session with a background-tagged GET /api/auth/me', async () => {
    stubNotification('denied');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(meFetch).toHaveBeenCalledWith('/api/auth/me', expect.anything());
    const init = meFetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('X-Background')).toBe('1');
  });

  it('stale stored user + dead session → no reminder, no auto-ask, "seen" NOT used up; after login it shows', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u-1' })); // stale leftover
    mockSession(null); // the session is dead → this page is about to bounce to login
    const n = stubNotification('default', 'default');
    const first = renderBajaj();
    await waitFor(() => expect(meFetch).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull();
    first.unmount();

    // The user signs in again (same browser session) → the reminder shows.
    mockSession('u-1');
    renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('service-worker reload right after the first render (brand-new session) → the reminder shows again after the reload', async () => {
    stubNotification('denied');
    const first = renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // ~1 s in, the SW's first clients.claim() → controllerchange → ServiceWorkerRegister reloads the page.
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull(); // not burned at render time
    first.unmount();

    // The reloaded page (same session).
    renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('"seen" is recorded only after the reminder has been on screen for REMINDER_SEEN_AFTER_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubNotification('denied');
    const first = renderBajaj();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMINDER_SEEN_AFTER_MS - 100);
    });
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBe('u-1');
    first.unmount();
    vi.useRealTimers();

    // A later reload in the same session → not shown again.
    const second = renderBajaj();
    await waitFor(() => expect(meFetch).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(second.container.firstChild).toBeNull();
  });

  it('tapping Enable records "seen" at once (a reload mid-prompt does not re-show it)', async () => {
    const n = stubNotification('default', 'default');
    const first = renderBajaj();
    await screen.findByRole('dialog');
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull();
    n.requestPermission.mockImplementationOnce(() => new Promise<NotificationPermission>(() => {})); // prompt open
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBe('u-1');
    first.unmount();
  });

  it('Android, permission default → reminder with an Enable button that asks from the tap and subscribes on grant', async () => {
    const n = stubNotification('default', 'default'); // auto-ask: prompt never shown
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('enable');
    expect(screen.getByRole('heading', { name: 'Turn on notifications' })).toBeTruthy();
    expect(screen.getByText(/wants to show notifications/)).toBeTruthy();
    expect(n.requestPermission).toHaveBeenCalledTimes(1); // the automatic ask at load

    n.requestPermission.mockImplementationOnce(async () => {
      n.permission = 'granted';
      return 'granted';
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    });
    expect(n.requestPermission).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Android auto-ask granted → subscribes, no reminder', async () => {
    stubNotification('default', 'granted');
    renderBajaj();
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('auto-ask that never resolves (quiet chip) → reminder after the timeout; a late Allow subscribes and closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveAsk: (p: NotificationPermission) => void = () => {};
    const fake = {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn(() => new Promise<NotificationPermission>((r) => { resolveAsk = r; })),
    };
    vi.stubGlobal('Notification', fake);
    renderBajaj();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_ASK_TIMEOUT_MS - 100);
    });
    expect(screen.queryByRole('dialog')).toBeNull(); // still waiting on the prompt
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole('dialog').getAttribute('data-kind')).toBe('enable');

    // The user finally taps Allow on the chip.
    await act(async () => {
      fake.permission = 'granted';
      resolveAsk('granted');
      await Promise.resolve();
    });
    vi.useRealTimers();
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Enable answered "denied" while permission still reads "default" (Chrome embargo) → specific message, not the Blocked steps', async () => {
    const n = stubNotification('default', 'default');
    renderBajaj();
    await screen.findByRole('dialog');
    n.requestPermission.mockImplementationOnce(async () => 'denied'); // permission stays 'default'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    });
    expect(screen.getByRole('dialog').getAttribute('data-kind')).toBe('enable');
    expect(screen.getByTestId('notif-reminder-message').textContent).toMatch(
      /Chrome is blocking the prompt for now — try again later, or allow notifications for this site in Chrome’s Site settings/,
    );
    expect(screen.queryByText(/Under Blocked/)).toBeNull();
  });

  it('Enable answered "denied" and permission reads "denied" → the Blocked steps', async () => {
    const n = stubNotification('default', 'default');
    renderBajaj();
    await screen.findByRole('dialog');
    n.requestPermission.mockImplementationOnce(async () => {
      n.permission = 'denied';
      return 'denied';
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
    });
    expect(screen.getByRole('dialog').getAttribute('data-kind')).toBe('blocked');
  });

  it('iPhone Safari tab → install-first steps and NO Enable button (and no auto-ask)', async () => {
    platform = 'ios-safari';
    setUa(UA.iphone17);
    disablePushSupport(); // real Safari tabs don't expose push
    vi.stubGlobal('Notification', undefined);
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('install-first');
    expect(screen.getByRole('heading', { name: 'Add the app to your Home Screen first' })).toBeTruthy();
    expect(screen.getByText(/In Safari, tap Share/)).toBeTruthy();
    expect(screen.getByText(/Open the app from the new Home Screen icon/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });

  it('iPhone in Chrome → install-first uses Chrome’s Share menu, Safari as fallback', async () => {
    platform = 'ios-safari';
    inSafari = false;
    setUa(UA.iphoneChrome);
    disablePushSupport();
    vi.stubGlobal('Notification', undefined);
    renderBajaj();
    expect(await screen.findByText(/in Chrome it’s in the address bar or under •••/)).toBeTruthy();
    expect(screen.getByText(/Open this page in Safari and do it there/)).toBeTruthy();
  });

  it('iPhone Home Screen app, permission default → Enable button and NO gesture-less auto-ask', async () => {
    platform = 'ios-app';
    setUa(UA.iphone17);
    const n = stubNotification('default', 'default');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('enable');
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeTruthy();
    expect(screen.getByText('When the iPhone asks, tap Allow.')).toBeTruthy();
  });

  it('iPad Home Screen app in desktop mode (unknown iOS version) without push → neutral line, not "can’t show"', async () => {
    platform = 'ios-app';
    setUa(UA.ipadDesktopNoVersion);
    disablePushSupport();
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('unsupported');
    expect(screen.getByText(/need iOS \/ iPadOS 16.4 or later/)).toBeTruthy();
    expect(screen.queryByText(/can’t show notifications/)).toBeNull();
  });

  it('iPhone below iOS 16.4 → one plain line, no steps, no Enable', async () => {
    platform = 'ios-safari';
    setUa(UA.iphone16_3);
    disablePushSupport();
    vi.stubGlobal('Notification', undefined);
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('ios-too-old');
    expect(screen.getByText(/need iOS 16.4 or later/)).toBeTruthy();
    expect(screen.queryByTestId('notif-reminder-steps')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });

  it('push not supported (Android browser without Push API) → one plain line only', async () => {
    disablePushSupport();
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('unsupported');
    expect(screen.getByText(/can’t show notifications/)).toBeTruthy();
    expect(screen.queryByTestId('notif-reminder-steps')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done — check again' })).toBeNull();
  });

  it('Android Chrome denied → Chrome steps + "Done — check again"; still denied says so; granting afterwards subscribes', async () => {
    const n = stubNotification('denied');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('blocked');
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByText(/⋮ \(top right\) → Settings → Site settings → Notifications/)).toBeTruthy();
    expect(screen.getByText(`Under Blocked, tap ${window.location.host} → Allow.`)).toBeTruthy();
    expect(screen.getByText(/the Bajaj Consumer Care Ltd Sales app \(or Chrome\)/)).toBeTruthy();
    expect(screen.getByText(/Do Not Disturb/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    expect(screen.getByTestId('notif-reminder-message').textContent).toMatch(/Still blocked/);
    expect(subscribeToPush).not.toHaveBeenCalled();

    n.permission = 'granted';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Samsung Internet denied → Samsung Internet menu path, not Chrome’s', async () => {
    setUa(UA.samsung);
    stubNotification('denied');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(screen.getByText(/Open Samsung Internet and tap ≡ \(menu\) → Settings → Sites and downloads/)).toBeTruthy();
    expect(screen.getByText(/the Bajaj Consumer Care Ltd Sales app \(or Samsung Internet\)/)).toBeTruthy();
    expect(screen.queryByText(/⋮/)).toBeNull();
  });

  it('iPhone app denied → iPhone Settings steps', async () => {
    platform = 'ios-app';
    setUa(UA.iphone17);
    stubNotification('denied');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(screen.getByText('Open the iPhone Settings app → Notifications.')).toBeTruthy();
    expect(screen.getByText(/Tap the Bajaj Consumer Care Ltd Sales app in the list and turn on Allow Notifications/)).toBeTruthy();
  });

  it('granted after "check again" but the subscription fails → honest heading + message', async () => {
    const n = stubNotification('denied');
    subscribeToPush.mockResolvedValue('error');
    renderBajaj();
    await screen.findByRole('dialog');
    n.permission = 'granted';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    expect(await screen.findByRole('heading', { name: 'Notifications allowed — setup not finished' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Notifications are on' })).toBeNull();
    expect(screen.getByText(/couldn’t finish setting them up/, { selector: '#notif-reminder-intro' })).toBeTruthy();
  });

  it('granted → nothing shown (only the silent re-sync), no session lookup needed', async () => {
    stubNotification('granted');
    const { container } = renderBajaj();
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Remind me later" hides it for the rest of the session; a new session shows it again', async () => {
    const n = stubNotification('denied');
    const first = renderBajaj();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBe('u-1');
    first.unmount();

    const second = renderBajaj();
    await waitFor(() => expect(meFetch).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(second.container.firstChild).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
    second.unmount();

    sessionStorage.clear();
    renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('dismissed this session in the default state → no automatic ask either', async () => {
    const n = stubNotification('default', 'default');
    const first = renderBajaj();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    first.unmount();
    n.requestPermission.mockClear();
    renderBajaj();
    await waitFor(() => expect(meFetch).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a different CONFIRMED user in the same browser session sees it again', async () => {
    stubNotification('denied');
    const first = renderBajaj();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }));
    first.unmount();
    mockSession('u-2');
    renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a11y: labelled modal, heading focused, Escape closes; backdrop tap does NOT dismiss; scroll lock + inert background restored on close', async () => {
    const outside = document.createElement('div');
    outside.id = 'page-content';
    document.body.appendChild(outside);
    stubNotification('denied');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const heading = screen.getByRole('heading', { name: 'Notifications are blocked' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(document.activeElement).toBe(heading);
    expect(document.body.style.overflow).toBe('hidden');
    expect(outside.hasAttribute('inert')).toBe(true);
    expect(outside.getAttribute('aria-hidden')).toBe('true');

    // A stray tap on the dimmed backdrop keeps it open.
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(outside.hasAttribute('inert')).toBe(false);
    expect(outside.hasAttribute('aria-hidden')).toBe(false);
    outside.remove();
  });

  it('never shows outside /sales and /partner', async () => {
    window.history.pushState({}, '', '/admin/dashboards/kyc');
    const n = stubNotification('denied');
    const { container } = renderBajaj();
    await act(async () => {});
    expect(container.firstChild).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(meFetch).not.toHaveBeenCalled();
  });

  it('never shows the old bottom bar together with the reminder', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true'); // as on staging/prod
    stubNotification('default', 'default');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByText('Enable notifications to get timely updates.')).toBeNull();
  });

  it('with InstallPrompt mounted (iPhone Safari first visit): one modal at a time — the reminder waits for the install card', async () => {
    platform = 'ios-safari';
    setUa(UA.iphone17);
    disablePushSupport();
    vi.stubGlobal('Notification', undefined);
    render(
      <>
        <InstallPrompt tenantSlug="bajaj" />
        <PushSubscriptionManager tenantSlug="bajaj" appName="Bajaj Consumer Care Ltd Sales" />
      </>,
    );
    expect(await screen.findByRole('dialog', { name: 'Install app' })).toBeTruthy();
    await waitFor(() => expect(meFetch).toHaveBeenCalled());
    await act(async () => {});
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(screen.queryByTestId('notif-reminder')).toBeNull();
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull(); // not "seen" while it waits

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const reminder = await screen.findByTestId('notif-reminder');
    expect(reminder.getAttribute('data-kind')).toBe('install-first');
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }));
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBe('u-1');
  });
});

describe('non-Bajaj tenants are unchanged (byte-identical)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllEnvs();
    subscribeToPush.mockClear();
    meFetch.mockReset();
    mockSession('u-1');
    vi.stubGlobal('fetch', meFetch);
    window.history.pushState({}, '', '/sales/dashboard');
    enablePushSupport();
    platform = 'android';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('Deoleo with the push flag ON + default → the original one-line bar, no reminder, no session lookup', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    const n = stubNotification('default');
    render(<PushSubscriptionManager tenantSlug="deoleo" appName="Deoleo Sales" />);
    expect(screen.getByText('Enable notifications to get timely updates.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(screen.queryByTestId('notif-reminder')).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(meFetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REMINDER_SESSION_KEY)).toBeNull();
  });

  it('Deoleo denied → still renders nothing (no steps)', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('denied');
    const { container } = render(<PushSubscriptionManager tenantSlug="deoleo" />);
    expect(container.firstChild).toBeNull();
  });

  it('Deoleo with push unsupported → nothing (no "unsupported" line)', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    disablePushSupport();
    stubNotification('default');
    const { container } = render(<PushSubscriptionManager tenantSlug="deoleo" />);
    expect(container.firstChild).toBeNull();
  });
});
