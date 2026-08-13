/// <reference types="vitest/globals" />
/**
 * GSEC — Gifsy platform-home security-breach metric card
 *
 * The card reads GET /api/gifsy/security-events (GIFSY-platform-only; 403s for
 * CLIENT_ADMIN / assumed operators). It is fail-closed: it renders ONLY when the
 * envelope is {success:true} with a numeric count > 0, and NEVER surfaces an error.
 *
 * GSEC1: {count:3} → alert card renders with "3" and links to /gifsy/security-events
 * GSEC2: {count:0} → no alert card
 * GSEC3: {success:false} (403 body) → card absent, page still renders
 * GSEC4: rejected fetch → card absent, no throw, page still renders
 *
 * Run: npx vitest run src/app/gifsy/__tests__/security-metric.test.tsx
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import GifsyOverviewPage from '../page';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// The overview fetch always resolves empty-but-successful so the rest of the page
// renders; each test overrides only the security-events response.
const OVERVIEW_OK = {
  success: true,
  data: { totalClients: 0, active: 0, onboarding: 0, inactive: 0, clients: [] },
};

function stubFetch(securityResponse: { ok?: boolean; body?: unknown; reject?: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/security-events')) {
        if (securityResponse.reject) return Promise.reject(new Error('Network error'));
        return Promise.resolve({ ok: securityResponse.ok ?? true, json: () => Promise.resolve(securityResponse.body) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(OVERVIEW_OK) });
    }),
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GSEC — platform-home security-breach metric', () => {
  it('GSEC1: renders the alert card with the count and links to the security route', async () => {
    stubFetch({ body: { success: true, data: { windowDays: 30, count: 3 } } });
    render(<GifsyOverviewPage />);

    const alert = await screen.findByText(/refresh-token reuse events/i);
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/\b3\b/);
    expect(alert.textContent).toMatch(/last 30d/i);

    const link = alert.closest('a');
    expect(link).toHaveAttribute('href', '/gifsy/security-events');
  });

  it('GSEC2: count 0 → no alert card', async () => {
    stubFetch({ body: { success: true, data: { windowDays: 30, count: 0 } } });
    render(<GifsyOverviewPage />);

    // Platform Overview heading proves the page rendered.
    expect(await screen.findByText('Platform Overview')).toBeInTheDocument();
    // Give the security-events fetch a tick to resolve, then confirm no card.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/gifsy/security-events', expect.anything()));
    expect(screen.queryByText(/refresh-token reuse events/i)).not.toBeInTheDocument();
  });

  it('GSEC3: {success:false} (403 body) → card absent, page still renders (fail-closed)', async () => {
    stubFetch({ ok: false, body: { success: false, error: 'Forbidden' } });
    render(<GifsyOverviewPage />);

    expect(await screen.findByText('Platform Overview')).toBeInTheDocument();
    expect(screen.queryByText(/refresh-token reuse events/i)).not.toBeInTheDocument();
  });

  it('GSEC4: rejected fetch → card absent, no throw, page still renders (fail-closed)', async () => {
    stubFetch({ reject: true });
    render(<GifsyOverviewPage />);

    expect(await screen.findByText('Platform Overview')).toBeInTheDocument();
    expect(screen.queryByText(/refresh-token reuse events/i)).not.toBeInTheDocument();
  });
});
