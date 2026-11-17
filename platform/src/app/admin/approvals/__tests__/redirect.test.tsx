/// <reference types="vitest/globals" />
/**
 * A2/R5 — /admin/approvals is retired. It was an unlinked page whose Approve/Reject buttons only changed
 * local state (nothing was ever saved). A bookmark / direct visit is sent, by role, to the real surface:
 *   - GIFSY operators (GIFSY_ADMIN / GIFSY_STAFF) → /admin/kyc/approvals (the GIFSY review queue);
 *   - everyone else (CLIENT_ADMIN, MIS_USER, unknown) → /admin/kyc — a CLIENT_ADMIN must never use the
 *     GIFSY queue (e2e/clientAdmin/scoping.e2e.ts Q2).
 * Client-side `router.replace` (same mechanism as /admin/outlets: a server `redirect()` is swallowed by the
 * 'use client' admin layout's error boundary in this Next build). The role is the logged-in JWT user.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push, prefetch: vi.fn() }) }));
const storedUser = vi.fn();
vi.mock('@/lib/auth-client', () => ({ getStoredUser: () => storedUser() }));

import AdminApprovalsRedirect from '../page';

async function landsOn(role: string | null) {
  storedUser.mockReturnValue(role ? { id: 'u1', name: 'X', role, phone: '' } : null);
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const { container } = render(<AdminApprovalsRedirect />);
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(push).not.toHaveBeenCalled(); // replace — Back never returns to the dead URL
  expect(container).toBeEmptyDOMElement();
  expect(fetchSpy).not.toHaveBeenCalled(); // the old page's queue fetch is gone
  vi.unstubAllGlobals();
  return replace.mock.calls[0][0];
}

describe('A2/R5 — /admin/approvals redirect by role', () => {
  beforeEach(() => { replace.mockClear(); push.mockClear(); storedUser.mockReset(); });

  it.each(['GIFSY_ADMIN', 'GIFSY_STAFF'])('%s → the GIFSY review queue /admin/kyc/approvals', async (role) => {
    expect(await landsOn(role)).toBe('/admin/kyc/approvals');
  });

  it.each(['CLIENT_ADMIN', 'MIS_USER'])('%s → /admin/kyc (never the GIFSY queue)', async (role) => {
    expect(await landsOn(role)).toBe('/admin/kyc');
  });

  it('no stored user → /admin/kyc (the safe, non-GIFSY default)', async () => {
    expect(await landsOn(null)).toBe('/admin/kyc');
  });
});
