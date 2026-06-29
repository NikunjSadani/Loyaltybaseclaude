import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the install-prompt store so the component's banner gating is driven by a
// controllable hook (the store's own capture logic is tested separately).
const promptInstall = vi.fn().mockResolvedValue('accepted');
let mockState = { canInstall: false, installed: false };
vi.mock('@/lib/pwa/install-prompt-store', () => ({
  useInstallPrompt: () => ({ ...mockState, promptInstall }),
}));

import InstallPrompt from '../InstallPrompt';

function setPath(p: string) {
  window.history.pushState({}, '', p);
}

const SNOOZE_KEY = 'pwa-install-snooze';
const DAY = 24 * 60 * 60 * 1000;

describe('InstallPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    promptInstall.mockClear();
    mockState = { canInstall: false, installed: false };
    setPath('/sales');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders nothing when the flag is OFF (default)', () => {
    mockState = { canInstall: true, installed: false };
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing outside /sales+/partner even with the flag ON', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: true, installed: false };
    setPath('/admin/dashboards/kyc');
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the install store reports already installed', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: false, installed: true };
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the Install affordance when canInstall and clicking calls promptInstall', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: true, installed: false };
    render(<InstallPrompt />);

    const btn = screen.getByRole('button', { name: 'Install' });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });

    expect(promptInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the banner while snoozed within the last 3 days', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: true, installed: false };
    // Snoozed 1 day ago — still inside the 3-day window.
    localStorage.setItem(SNOOZE_KEY, String(Date.now() - 1 * DAY));
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the banner again once the 3-day snooze has expired', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: true, installed: false };
    // Snoozed 4 days ago — the snooze has expired.
    localStorage.setItem(SNOOZE_KEY, String(Date.now() - 4 * DAY));
    render(<InstallPrompt />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('dismiss writes a fresh snooze timestamp instead of a permanent flag', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    mockState = { canInstall: true, installed: false };
    render(<InstallPrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const stored = Number(localStorage.getItem(SNOOZE_KEY));
    expect(Number.isFinite(stored)).toBe(true);
    // Recent timestamp (within the last few seconds).
    expect(Date.now() - stored).toBeLessThan(5000);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
