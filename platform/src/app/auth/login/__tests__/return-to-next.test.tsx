/// <reference types="vitest/globals" />
/**
 * Return-to after sign-in: a signed-out ticket-email link (`/auth/login?next=/admin/tickets?ticket=…`)
 * lands back on the ticket after the OTP — or straight away when a session is still live — but only
 * for a same-origin relative path into a portal the role may open (never an open redirect).
 * Run: npx vitest run src/app/auth/login/__tests__/return-to-next.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const apiGet = vi.fn();
const sendOTP = vi.fn();
const verifyOTP = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) }, authHeader: () => ({}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../actions', () => ({ sendOTP: (...a: unknown[]) => sendOTP(...a), verifyOTP: (...a: unknown[]) => verifyOTP(...a) }));
vi.mock('@/lib/stale-deploy', () => ({ isStaleDeploymentError: () => false, recoverFromStaleDeployment: vi.fn() }));
vi.mock('@/lib/active-partner-actions', () => ({ setActivePartner: vi.fn() }));

import LoginPage from '../page';

let originalLocation: Location;
const setSearch = (search: string) =>
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: `http://localhost/auth/login${search}`, search, pathname: '/auth/login' },
  });

beforeEach(() => {
  apiGet.mockReset(); sendOTP.mockReset(); verifyOTP.mockReset();
  originalLocation = window.location;
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  localStorage.clear();
});

const NEXT = `?next=${encodeURIComponent('/admin/tickets?ticket=t1')}`;

async function loginWithOtp(role: string) {
  apiGet.mockResolvedValue({ success: false, error: 'no session' });
  sendOTP.mockResolvedValue({ success: true });
  verifyOTP.mockResolvedValue({ success: true, role, user: { id: 'u', name: 'U', role, phone: '9' } });
  render(<LoginPage />);
  const mobile = await screen.findByPlaceholderText('9876543210');
  fireEvent.change(mobile, { target: { value: '9876543210' } });
  fireEvent.click(screen.getByRole('button', { name: /Send OTP/i }));
  await waitFor(() => expect(sendOTP).toHaveBeenCalled());
  const boxes = await screen.findAllByRole('textbox');
  const otpBoxes = boxes.slice(-6);
  otpBoxes.forEach((b, i) => fireEvent.change(b, { target: { value: String(i + 1) } }));
  fireEvent.click(screen.getByRole('button', { name: /Verify OTP/i }));
  await waitFor(() => expect(verifyOTP).toHaveBeenCalled());
}

describe('login ?next= return-to', () => {
  it('after OTP a client admin lands on the ticket deep link', async () => {
    setSearch(NEXT);
    await loginWithOtp('CLIENT_ADMIN');
    await waitFor(() => expect(window.location.href).toBe('/admin/tickets?ticket=t1'));
  });

  it('a live session is bounced straight to the deep link', async () => {
    setSearch(NEXT);
    apiGet.mockResolvedValue({ success: true, data: { role: 'CLIENT_ADMIN', user: { id: 'u', name: 'U', phone: '9' } } });
    render(<LoginPage />);
    await waitFor(() => expect(window.location.href).toBe('/admin/tickets?ticket=t1'));
  });

  it('an off-site next is ignored (no open redirect) → role home', async () => {
    setSearch(`?next=${encodeURIComponent('//evil.example/admin')}`);
    await loginWithOtp('CLIENT_ADMIN');
    await waitFor(() => expect(window.location.href).toBe('/admin/dashboard'));
  });

  it('a next into a portal the role cannot open is ignored → role home', async () => {
    setSearch(NEXT);
    await loginWithOtp('SALES_ISR');
    await waitFor(() => expect(window.location.href).toBe('/sales/dashboard'));
  });
});
