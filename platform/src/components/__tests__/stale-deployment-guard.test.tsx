import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import StaleDeploymentGuard from '@/components/StaleDeploymentGuard';

const reload = vi.fn();
beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/', pathname: '/', origin: 'http://localhost', reload },
  });
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
});

describe('StaleDeploymentGuard', () => {
  it('reloads on an UNCAUGHT stale server-action rejection, but ignores unrelated rejections', () => {
    render(<StaleDeploymentGuard />);

    // jsdom has no PromiseRejectionEvent — dispatch a plain event carrying `reason`
    // (exactly what the guard's handler reads).
    const rejection = (reason: unknown) => {
      const ev = new Event('unhandledrejection') as Event & { reason?: unknown };
      ev.reason = reason;
      return ev;
    };

    // unrelated rejection → no reload
    window.dispatchEvent(rejection(new Error('Something else broke')));
    expect(reload).not.toHaveBeenCalled();

    // stale server-action rejection → one-shot reload
    window.dispatchEvent(rejection(new Error('Failed to find Server Action "abc". This request might be from an older or newer deployment.')));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
