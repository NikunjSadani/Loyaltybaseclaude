/// <reference types="vitest/globals" />
/**
 * FUND access (B4/C1, C13):
 *  A1: /admin/fund admits GIFSY_ADMIN, GIFSY_STAFF and CLIENT_ADMIN; bounces MIS_USER
 *  A2: a GIFSY_STAFF needs payouts:read on /admin/fund (AdminRouteGuard map)
 *  A3: the retired /admin/payouts/fund path is let through the payouts guard (its page redirects to /admin/fund,
 *      whose guard decides) — every other payouts path stays GIFSY_ADMIN / GIFSY_STAFF only
 * Run: npx vitest run src/app/admin/fund/__tests__/fund-access.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const replace = vi.fn();
const pathRef = vi.hoisted(() => ({ current: '/admin/fund' }));
const roleRef = vi.hoisted(() => ({ current: 'GIFSY_STAFF' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathRef.current,
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock('@/lib/auth-client', () => ({
  getStoredUser: () => ({ role: roleRef.current }),
  getRoleHome: (r: string) => (r === 'MIS_USER' ? '/admin/dashboard' : '/'),
}));

import FundLayout from '../layout';
import PayoutsLayout from '../../payouts/layout';
import { requiredPermissionForPath } from '@/lib/rbac/route-permissions';

beforeEach(() => { replace.mockReset(); pathRef.current = '/admin/fund'; });

describe('FUND access', () => {
  it.each([['GIFSY_ADMIN'], ['GIFSY_STAFF'], ['CLIENT_ADMIN']])('A1: /admin/fund admits %s', async (role) => {
    roleRef.current = role;
    render(<FundLayout><p>fund page</p></FundLayout>);
    expect(await screen.findByText('fund page')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('A1: /admin/fund bounces MIS_USER home', async () => {
    roleRef.current = 'MIS_USER';
    render(<FundLayout><p>fund page</p></FundLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/dashboard'));
    expect(screen.queryByText('fund page')).not.toBeInTheDocument();
  });

  it('A2: a GIFSY_STAFF needs payouts:read on /admin/fund', () => {
    expect(requiredPermissionForPath('/admin/fund')).toBe('payouts:read');
  });

  it('A3 (C13): /admin/payouts/fund lets a CLIENT_ADMIN through to the redirect; /admin/payouts still bounces them', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    pathRef.current = '/admin/payouts/fund';
    const { unmount } = render(<PayoutsLayout><p>redirecting</p></PayoutsLayout>);
    expect(await screen.findByText('redirecting')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    unmount();

    pathRef.current = '/admin/payouts';
    render(<PayoutsLayout><p>batches</p></PayoutsLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(screen.queryByText('batches')).not.toBeInTheDocument();
  });
});
