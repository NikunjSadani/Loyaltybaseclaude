/// <reference types="vitest/globals" />
/**
 * Admin KYC detail — the "Target history" link next to the Outlet ID is shown ONLY to roles that can open it
 * (CLIENT_ADMIN / GIFSY_ADMIN, + GIFSY_STAFF holding targets:read — usePermissions), never to others.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) return { id: 'KYC002' };
      return actual.use(val as React.Context<unknown>);
    }),
  };
});
const perms = vi.hoisted(() => ({ role: 'CLIENT_ADMIN' as string | null, granted: [] as string[], ready: true }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: perms.role,
    permissions: perms.granted,
    ready: perms.ready,
    error: false,
    retry: () => {},
    has: (p: string) => perms.role !== 'GIFSY_STAFF' || perms.granted.includes(p),
  }),
}));

import KYCDetailPage from '../page';

const LOAD = { timeout: 15_000 };
const createdAt = new Date(Date.now() - 2 * 86_400_000).toISOString();

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: {
      id: 'KYC002', status: 'PENDING_GIFSY', submittedAt: createdAt, createdAt,
      user: { id: 'u1', name: 'Rohit', phone: '9820184321', role: 'SALES_SO' },
      partner: { id: 'p1', businessName: 'Sharma Store', ownerName: 'Anil', partnerCode: 'CP777',
        outlets: [{ outletCode: 'O 999', name: 'Sharma Store', city: 'Mumbai', state: 'MH', pincode: '400053' }] },
      documents: [], statusHistory: [],
    } } }),
  }));
}

beforeEach(() => { perms.role = 'CLIENT_ADMIN'; perms.granted = []; perms.ready = true; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('KYC detail — Target history link (role-gated)', { timeout: 30_000 }, () => {
  it.each([['CLIENT_ADMIN'], ['GIFSY_ADMIN']])('%s → link to that outlet\'s target history', async (role) => {
    perms.role = role;
    stubFetch();
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    const link = await screen.findByRole('link', { name: 'Target history' }, LOAD);
    expect(link).toHaveAttribute('href', '/admin/targets/history?outletCode=O%20999');
  });

  it('GIFSY_STAFF WITH targets:read → link; WITHOUT → no link', async () => {
    perms.role = 'GIFSY_STAFF';
    perms.granted = ['targets:read'];
    stubFetch();
    const { unmount } = render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    expect(await screen.findByRole('link', { name: 'Target history' }, LOAD)).toBeInTheDocument();
    unmount();
    perms.granted = ['kyc:read'];
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    expect(await screen.findByText(/Outlet ID:/, undefined, LOAD)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Target history' })).toBeNull();
  });

  it('any other role (e.g. a KYC reviewer) → no link', async () => {
    perms.role = 'KYC_REVIEWER';
    stubFetch();
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC002' })} />);
    expect(await screen.findByText(/Outlet ID:/, undefined, LOAD)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Target history' })).toBeNull();
  });
});
