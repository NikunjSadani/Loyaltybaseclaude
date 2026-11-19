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

import PushSubscriptionManager, { REMINDER_SESSION_KEY } from '../PushSubscriptionManager';

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  iphone16_3: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
};

/** A fake Notification whose permission really changes when requestPermission resolves (like a browser). */
function stubNotification(permission: NotificationPermission, requestResult: NotificationPermission = permission) {
  const fake = {
    permission,
    requestPermission: vi.fn(async () => {
      fake.permission = requestResult;
      return requestResult;
    }),
  };
  vi.stubGlobal('Notification', fake);
  return fake;
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

const renderBajaj = () => render(<PushSubscriptionManager tenantSlug="bajaj" appName="Bajaj Sales" />);

describe('Bajaj notification reminder', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('user', JSON.stringify({ id: 'u-1', name: 'Rep', role: 'SALES_REP' }));
    vi.unstubAllEnvs();
    subscribeToPush.mockClear();
    subscribeToPush.mockResolvedValue('subscribed');
    window.history.pushState({}, '', '/sales/dashboard');
    enablePushSupport();
    platform = 'android';
    inSafari = true;
    setUa(UA.android);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Android, permission default → reminder with an Enable button that asks from the tap and subscribes on grant', async () => {
    const n = stubNotification('default', 'default'); // auto-ask: prompt never shown
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('enable');
    expect(screen.getByRole('heading', { name: 'Turn on notifications' })).toBeTruthy();
    expect(screen.getByText(/wants to show notifications/)).toBeTruthy();
    expect(n.requestPermission).toHaveBeenCalledTimes(1); // the automatic ask at load

    // The user taps Enable and allows this time.
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

  it('iPhone Safari tab → install-first steps and NO Enable button (and no auto-ask)', async () => {
    platform = 'ios-safari';
    setUa(UA.iphone17);
    disablePushSupport(); // real Safari tabs don't expose push
    vi.stubGlobal('Notification', undefined);
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('install-first');
    expect(screen.getByRole('heading', { name: 'Add the app to your Home Screen first' })).toBeTruthy();
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    expect(screen.getByText(/Open the app from the new Home Screen icon/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
    expect(screen.queryByText('Open this page in Safari.')).toBeNull();
  });

  it('iPhone in Chrome (not Safari) → install-first starts with "Open this page in Safari"', async () => {
    platform = 'ios-safari';
    inSafari = false;
    setUa(UA.iphone17);
    disablePushSupport();
    vi.stubGlobal('Notification', undefined);
    renderBajaj();
    expect(await screen.findByText('Open this page in Safari.')).toBeTruthy();
  });

  it('iPhone Home Screen app, permission default → Enable button', async () => {
    platform = 'ios-app';
    setUa(UA.iphone17);
    stubNotification('default', 'default');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('enable');
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeTruthy();
    expect(screen.getByText('When the iPhone asks, tap Allow.')).toBeTruthy();
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

  it('Android denied → Chrome steps + "Done — check again"; still denied says so; granting afterwards subscribes', async () => {
    const n = stubNotification('denied');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-kind')).toBe('blocked');
    expect(n.requestPermission).not.toHaveBeenCalled(); // can't ask again — never tries
    expect(screen.getByText(/Site settings → Notifications/)).toBeTruthy();
    expect(screen.getByText(`Under Blocked, tap ${window.location.host} → Allow.`)).toBeTruthy();
    expect(screen.getByText(/the Bajaj Sales app \(or Chrome\)/)).toBeTruthy();
    expect(screen.getByText(/Do Not Disturb/)).toBeTruthy();

    // Still blocked → said out loud, dialog stays.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    expect(screen.getByTestId('notif-reminder-message').textContent).toMatch(/Still blocked/);
    expect(subscribeToPush).not.toHaveBeenCalled();

    // The user allows it in Chrome settings, comes back, checks again → subscribed + closed.
    n.permission = 'granted';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('iPhone app denied → iPhone Settings steps', async () => {
    platform = 'ios-app';
    setUa(UA.iphone17);
    stubNotification('denied');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(screen.getByText('Open the iPhone Settings app → Notifications.')).toBeTruthy();
    expect(screen.getByText(/Tap the Bajaj Sales app in the list and turn on Allow Notifications/)).toBeTruthy();
  });

  it('granted after "check again" but the subscription fails → says so (no silent pass-through)', async () => {
    const n = stubNotification('denied');
    subscribeToPush.mockResolvedValue('error');
    renderBajaj();
    await screen.findByRole('dialog');
    n.permission = 'granted';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done — check again' }));
    });
    expect(await screen.findByText(/couldn’t finish setting them up/, { selector: '#notif-reminder-intro' })).toBeTruthy();
  });

  it('granted → nothing shown (only the silent re-sync)', async () => {
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

    // Another page load in the same session → hidden.
    const second = renderBajaj();
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(second.container.firstChild).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
    second.unmount();

    // Next app open (new session) → back.
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
    await act(async () => {});
    expect(n.requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a different user signing in during the same browser session sees it again', async () => {
    stubNotification('denied');
    const first = renderBajaj();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remind me later' }));
    first.unmount();
    localStorage.setItem('user', JSON.stringify({ id: 'u-2' }));
    renderBajaj();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Escape closes it; the heading is focused on open; dialog is labelled', async () => {
    stubNotification('denied');
    renderBajaj();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const heading = screen.getByRole('heading', { name: 'Notifications are blocked' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(document.activeElement).toBe(heading);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never shows outside /sales and /partner', async () => {
    window.history.pushState({}, '', '/admin/dashboards/kyc');
    const n = stubNotification('denied');
    const { container } = renderBajaj();
    await act(async () => {});
    expect(container.firstChild).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled();
  });

  it('never shows the old bottom bar together with the reminder', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true'); // as on staging/prod
    stubNotification('default', 'default');
    renderBajaj();
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByText('Enable notifications to get timely updates.')).toBeNull();
  });
});

describe('non-Bajaj tenants are unchanged (byte-identical)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllEnvs();
    subscribeToPush.mockClear();
    window.history.pushState({}, '', '/sales/dashboard');
    enablePushSupport();
    platform = 'android';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('Deoleo with the push flag ON + default → the original one-line bar, no reminder', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    const n = stubNotification('default');
    render(<PushSubscriptionManager tenantSlug="deoleo" appName="Deoleo Sales" />);
    expect(screen.getByText('Enable notifications to get timely updates.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(screen.queryByTestId('notif-reminder')).toBeNull();
    expect(n.requestPermission).not.toHaveBeenCalled(); // no auto-ask for non-Bajaj
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
