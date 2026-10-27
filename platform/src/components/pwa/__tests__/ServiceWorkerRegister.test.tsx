import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module-scope NEXT_PUBLIC_PWA_SW_ENABLED read means the global-flag path can't be
// stubbed post-import; the Bajaj path (tenantSlug prop) is the one that matters here and is
// fully exercisable. These tests guard the highest-risk gate: the SW must register for Bajaj
// and NEVER for another tenant (a regression there would turn SW caching on for live Deoleo).
import ServiceWorkerRegister from '../ServiceWorkerRegister';

function setPath(p: string) { window.history.pushState({}, '', p); }

const register = vi.fn();

describe('ServiceWorkerRegister — tenant gate', () => {
  beforeEach(() => {
    register.mockReset().mockResolvedValue({ waiting: null, installing: null, addEventListener: vi.fn() });
    setPath('/sales');
    // Defined for the whole file (vitest isolates test files, so this never leaks to other
    // suites). NOT deleted in afterEach — doing so would race the effect-cleanup's
    // removeEventListener on unmount and throw.
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, addEventListener: vi.fn(), removeEventListener: vi.fn(), controller: null },
    });
  });

  it('registers /sw.js for the Bajaj tenant even with the flag OFF', async () => {
    render(<ServiceWorkerRegister tenantSlug="bajaj" />);
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith('/sw.js', expect.objectContaining({ scope: '/' })),
    );
  });

  it('does NOT register for a non-Bajaj tenant with the flag OFF (Deoleo byte-identical)', async () => {
    render(<ServiceWorkerRegister tenantSlug="deoleo" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(register).not.toHaveBeenCalled();
  });

  it('does NOT register outside /sales+/partner even for Bajaj', async () => {
    setPath('/admin/dashboards/kyc');
    render(<ServiceWorkerRegister tenantSlug="bajaj" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(register).not.toHaveBeenCalled();
  });
});
