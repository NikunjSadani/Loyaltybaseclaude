/// <reference types="vitest/globals" />
/**
 * SL-F — the sales layout publishes the tenant flags from its EXISTING /api/sales/me read via
 * SalesFeaturesContext (Help & videos gate). No new request: the layout still calls /api/sales/me once.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { useSalesFeatures } from '@/lib/sales-features-context';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/sales/profile' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/components/auth/require-auth', () => ({ RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/nav-bottom', () => ({ NavBottom: () => null }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));

import SalesLayout from '../layout';

function Probe() {
  const f = useSalesFeatures();
  return <p data-testid="probe">{f === null ? 'null' : String(f.helpVideos)}</p>;
}

function stub(features: Record<string, unknown> | undefined) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { name: 'Ravi', employeeCode: 'E1', features } }) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SL-F — sales layout features context', () => {
  it('flag ON in /api/sales/me → children read helpVideos=true; exactly one request', async () => {
    const fetchMock = stub({ helpVideos: true });
    render(<SalesLayout><Probe /></SalesLayout>);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('true'));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/sales/me']);
  });

  it('flag absent (Deoleo) → false', async () => {
    stub({});
    render(<SalesLayout><Probe /></SalesLayout>);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false'));
  });

  it('before /api/sales/me resolves → null (entry hidden)', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    render(<SalesLayout><Probe /></SalesLayout>);
    expect(screen.getByTestId('probe').textContent).toBe('null');
  });
});
