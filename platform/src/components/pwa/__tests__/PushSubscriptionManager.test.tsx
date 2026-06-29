import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the pure helpers so we can assert the component drives them correctly.
const subscribeToPush = vi.fn().mockResolvedValue('subscribed');
vi.mock('@/lib/pwa/push', () => ({
  subscribeToPush: () => subscribeToPush(),
}));

import PushSubscriptionManager from '../PushSubscriptionManager';

function setPath(p: string) {
  window.history.pushState({}, '', p);
}

// Install a fake Notification with a controllable permission + requestPermission.
function stubNotification(permission: NotificationPermission, requestResult = permission) {
  const requestPermission = vi.fn().mockResolvedValue(requestResult);
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
}

function enablePushSupport() {
  // serviceWorker + PushManager must both be present.
  if (!('serviceWorker' in navigator)) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.resolve({}) },
      configurable: true,
    });
  }
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
}

describe('PushSubscriptionManager', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    subscribeToPush.mockClear();
    setPath('/sales');
    enablePushSupport();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('renders nothing and never subscribes when the flag is OFF (default)', () => {
    stubNotification('default');
    const { container } = render(<PushSubscriptionManager />);
    expect(container.firstChild).toBeNull();
    expect(subscribeToPush).not.toHaveBeenCalled();
  });

  it('renders nothing outside /sales+/partner even with the flag ON', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('default');
    setPath('/admin/dashboards/kyc');
    const { container } = render(<PushSubscriptionManager />);
    expect(container.firstChild).toBeNull();
  });

  it('with flag ON + permission "default", shows the Enable prompt', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('default');
    render(<PushSubscriptionManager />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
  });

  it('does not show the prompt once dismissed (persisted)', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    localStorage.setItem('pwa-push-dismissed', '1');
    stubNotification('default');
    const { container } = render(<PushSubscriptionManager />);
    expect(container.firstChild).toBeNull();
  });

  it('Enable -> requests permission and subscribes when granted', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    const requestPermission = stubNotification('default', 'granted');
    render(<PushSubscriptionManager />);

    const btn = screen.getByRole('button', { name: 'Enable' });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribeToPush).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enable -> requests permission but does NOT subscribe when denied', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    const requestPermission = stubNotification('default', 'denied');
    render(<PushSubscriptionManager />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
      await Promise.resolve();
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribeToPush).not.toHaveBeenCalled();
  });

  it('Not now -> persists the dismiss flag and hides', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('default');
    render(<PushSubscriptionManager />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(localStorage.getItem('pwa-push-dismissed')).toBe('1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('permission "granted" renders null but triggers an idempotent re-sync subscribe', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('granted');
    const { container } = render(<PushSubscriptionManager />);
    expect(container.firstChild).toBeNull();
    expect(subscribeToPush).toHaveBeenCalledTimes(1);
  });

  it('permission "denied" renders null and never subscribes or prompts', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_PUSH_ENABLED', 'true');
    stubNotification('denied');
    const { container } = render(<PushSubscriptionManager />);
    expect(container.firstChild).toBeNull();
    expect(subscribeToPush).not.toHaveBeenCalled();
  });
});
