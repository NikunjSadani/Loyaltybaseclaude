import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstallPrompt from '../InstallPrompt';

function setPath(p: string) {
  window.history.pushState({}, '', p);
}

describe('InstallPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    setPath('/sales');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders nothing when the flag is OFF (default)', () => {
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing outside /sales+/partner even with the flag ON', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    setPath('/admin/dashboards/kyc');
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('does not show again once dismissed (persisted)', () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    localStorage.setItem('pwa-install-dismissed', '1');
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('shows an Install affordance on beforeinstallprompt (Android) and persists dismissal on install', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    setPath('/sales');
    render(<InstallPrompt />);
    // Inert until the browser actually fires the install event.
    expect(screen.queryByRole('dialog')).toBeNull();

    const prompt = vi.fn().mockResolvedValue(undefined);
    const evt = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    evt.prompt = prompt;
    evt.userChoice = Promise.resolve({ outcome: 'accepted' });
    await act(async () => {
      window.dispatchEvent(evt);
    });

    const btn = screen.getByRole('button', { name: 'Install' });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('pwa-install-dismissed')).toBe('1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
