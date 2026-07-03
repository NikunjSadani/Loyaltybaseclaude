/// <reference types="vitest/globals" />
/**
 * SLA — Sales Profile "Log out from all devices" (#101 / Feature 10-i)
 *
 * SLA1: the menu item opens a confirm modal
 * SLA2: confirming POSTs /api/auth/logout-all, then clears cookies (logoutAction),
 *       then routes to /auth/login — in that order.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

// The server action that clears the httpOnly cookies — record call order vs fetch.
const order: string[] = [];
const logoutAction = vi.fn(async () => { order.push('logout'); return { success: true }; });
vi.mock('@/lib/auth-actions', () => ({ logoutAction: () => logoutAction() }));

import SalesProfilePage from '../page';

const MOCK_USER = {
  id: 'u1', name: 'Rajesh Kumar', phone: '9876543210', role: 'SALES_SO',
  salesUser: { employeeCode: 'EMP-1', region: 'Mumbai' },
};

afterEach(() => { vi.unstubAllGlobals(); order.length = 0; push.mockClear(); logoutAction.mockClear(); });

function installFetch() {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/auth/logout-all' && init?.method === 'POST') {
      order.push('logout-all');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { revoked: 2 } }) });
    }
    // /api/auth/me and /api/sales/outlets
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: MOCK_USER } }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('SLA — Sales Profile log out from all devices', () => {
  it('SLA1: opens the confirm modal from the menu item', async () => {
    installFetch();
    render(<SalesProfilePage />);
    await screen.findByText('Rajesh Kumar');

    await userEvent.click(screen.getByText('Log out from all devices'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/signs you out on all your devices/i)).toBeInTheDocument();
  });

  it('SLA2: confirming POSTs /api/auth/logout-all, then clears cookies, then routes to login', async () => {
    installFetch();
    render(<SalesProfilePage />);
    await screen.findByText('Rajesh Kumar');

    await userEvent.click(screen.getByText('Log out from all devices'));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /log out everywhere/i }));

    await waitFor(() => {
      expect(logoutAction).toHaveBeenCalled();
      expect(push).toHaveBeenCalledWith('/auth/login');
    });
    // Endpoint hit BEFORE the cookie-clearing logout action.
    expect(order).toEqual(['logout-all', 'logout']);
  });
});
