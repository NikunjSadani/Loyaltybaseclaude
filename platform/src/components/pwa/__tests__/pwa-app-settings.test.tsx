import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the install-prompt store (controllable hook) ──
const promptInstall = vi.fn().mockResolvedValue('accepted');
let installState = { canInstall: false, installed: false };
vi.mock('@/lib/pwa/install-prompt-store', () => ({
  useInstallPrompt: () => ({ ...installState, promptInstall }),
}));

// ── Mock the push helpers ──
const subscribeToPush = vi.fn().mockResolvedValue('subscribed');
const unsubscribeFromPush = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pwa/push', () => ({
  subscribeToPush: () => subscribeToPush(),
  unsubscribeFromPush: () => unsubscribeFromPush(),
}));

// ── Keep the iOS detection deterministic (default: not iOS) ──
let iosSafari = false;
vi.mock('@/lib/pwa/platform-detect', () => ({
  isIosSafari: () => iosSafari,
  isStandalone: () => false,
}));

import PwaAppSettings from '../PwaAppSettings';

function stubNotification(permission: NotificationPermission, requestResult = permission) {
  const requestPermission = vi.fn().mockResolvedValue(requestResult);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
}

function enablePushSupport() {
  if (!('serviceWorker' in navigator)) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.resolve({}), getRegistration: () => Promise.resolve(undefined) },
      configurable: true,
    });
  }
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
}

describe('PwaAppSettings', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    promptInstall.mockClear();
    subscribeToPush.mockClear();
    unsubscribeFromPush.mockClear();
    installState = { canInstall: false, installed: false };
    iosSafari = false;
    enablePushSupport();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('renders null when both flags are OFF (default)', () => {
    stubNotification('default');
    const { container } = render(<PwaAppSettings />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an Install button when canInstall (install flag ON)', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    installState = { canInstall: true, installed: false };
    stubNotification('default');
    render(<PwaAppSettings />);
    const btn = screen.getByRole('button', { name: 'Install app' });
    fireEvent.click(btn);
    expect(promptInstall).toHaveBeenCalledTimes(1);
  });

  it('shows "App installed ✓" when already installed', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    installState = { canInstall: false, installed: true };
    stubNotification('default');
    render(<PwaAppSettings />);
    expect(screen.getByText(/App installed/)).toBeTruthy();
  });

  it('shows the iOS Share instructions when on iOS Safari and not installable', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    installState = { canInstall: false, installed: false };
    iosSafari = true;
    stubNotification('default');
    render(<PwaAppSettings />);
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
  });

  it('renders an Enable button when notification permission is "default"', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('default');
    render(<PwaAppSettings />);
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeTruthy();
  });

  it('Enable -> requests permission and subscribes on grant', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    const requestPermission = stubNotification('default', 'granted');
    render(<PwaAppSettings />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));
      await Promise.resolve();
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribeToPush).toHaveBeenCalledTimes(1);
  });

  it('renders blocked guidance (no button) when permission is "denied"', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('denied');
    render(<PwaAppSettings />);
    expect(screen.getByText(/Notifications are blocked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });

  it('renders "On" + Turn off when permission is "granted"', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('granted');
    render(<PwaAppSettings />);
    expect(screen.getByText(/Notifications: On/)).toBeTruthy();
    const off = screen.getByRole('button', { name: 'Turn off' });
    await act(async () => {
      fireEvent.click(off);
      await Promise.resolve();
    });
    expect(unsubscribeFromPush).toHaveBeenCalledTimes(1);
  });

  it('renders null when only the push flag is on but push is unsupported', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    // Remove PushManager support.
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    stubNotification('default');
    const { container } = render(<PwaAppSettings />);
    // INSTALL flag is off and push unsupported => whole card is null.
    expect(container.firstChild).toBeNull();
  });
});
