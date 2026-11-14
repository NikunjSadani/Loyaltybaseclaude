/// <reference types="vitest/globals" />
/**
 * HOT — partner shell header title = the OUTLET name from the first paint (never the person).
 *
 * Bug: on every hard load the header title showed the login person's name (user.name, e.g.
 * "VIKRAM SINGH") until GET /partner/me resolved, then flipped to the outlet name. Fix: the
 * OTP-login reply carries the default outlet's businessName/outletName (stored with the user),
 * and usePartnerIdentity seeds the title from THOSE; /partner/me still overrides.
 *
 * HOT1: login-stored outlet name is the title while /partner/me is pending (person = sub-line only);
 *       the desktop sidebar shows the business name, not the person.
 * HOT2: /partner/me's value overrides the seeded one.
 * HOT3: a legacy stored user (no outlet fields) keeps today's behaviour (person name provisional).
 * HOT4: /partner/me failure (non-OK) keeps the login outlet name — never the person's.
 * HOT5: businessName-only login (no outlet master name) → businessName as the title.
 * HOT6: after an outlet pick (announceActivePartnerChanged) the header re-reads /partner/me and
 *       shows the picked outlet; a late response for the old outlet can't overwrite it.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/active-partner-actions', () => ({ setActivePartner: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@/components/layout/nav-bottom', () => ({ NavBottom: () => null }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ userName, userRole }: { userName?: string; userRole?: string }) => (
    <div data-testid="sidebar-user">{`${userName ?? ''}|${userRole ?? ''}`}</div>
  ),
}));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Brand' } }),
}));

import PartnerLayout from '../layout';
import { announceActivePartnerChanged } from '@/lib/partner-identity';

const PERSON = 'VIKRAM SINGH';

function storeUser(extra: Record<string, unknown> = {}) {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', name: PERSON, role: 'RETAILER', phone: '9', ...extra }));
}

type Deferred = { resolve: (v: unknown) => void; promise: Promise<unknown> };
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { resolve, promise };
}
const okMe = (data: Record<string, unknown>) => ({ ok: true, status: 200, json: () => Promise.resolve({ data }) });

let pending: Deferred[];
beforeEach(() => {
  pending = [];
  vi.stubGlobal('fetch', vi.fn(() => {
    const d = deferred();
    pending.push(d);
    return d.promise;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const title = (c: HTMLElement) => c.querySelector('header p.font-bold')?.textContent ?? '';

function renderShell() {
  return render(<PartnerLayout><div /></PartnerLayout>);
}

describe('HOT — partner header title from first paint', () => {
  it('HOT1: shows the login-stored OUTLET name (not the person) while /partner/me is pending', async () => {
    storeUser({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' });
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe('Chakradhar Marketing'));
    expect(pending).toHaveLength(1); // /partner/me still in flight
    expect(title(container)).not.toContain(PERSON);
    // Person name stays on the sub-line (same person) …
    expect(screen.getAllByText(PERSON).length).toBeGreaterThan(0);
    // … and the desktop sidebar shows the business, not the person, as its name line.
    expect(screen.getByTestId('sidebar-user').textContent).toBe(`Chakradhar Traders|${PERSON}`);
  });

  it('HOT2: /partner/me overrides the seeded values', async () => {
    storeUser({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' });
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe('Chakradhar Marketing'));
    await act(async () => {
      pending[0].resolve(okMe({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Mktg (Renamed)', ownerName: 'Vikram' }));
    });
    await waitFor(() => expect(title(container)).toBe('Chakradhar Mktg (Renamed)'));
  });

  it('HOT3: a legacy stored user without outlet fields keeps the old provisional person-name title', async () => {
    storeUser();
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe(PERSON));
    await act(async () => {
      pending[0].resolve(okMe({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' }));
    });
    await waitFor(() => expect(title(container)).toBe('Chakradhar Marketing'));
  });

  it('HOT4: a failed /partner/me keeps the login outlet name — never falls back to the person', async () => {
    storeUser({ businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' });
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe('Chakradhar Marketing'));
    await act(async () => {
      pending[0].resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });
    // Let the rejection settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(title(container)).toBe('Chakradhar Marketing');
  });

  it('HOT5: a login with no outlet master name shows the businessName as the title', async () => {
    storeUser({ businessName: 'Chakradhar Traders', outletName: null });
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe('Chakradhar Traders'));
  });

  it('HOT6: an outlet pick refreshes the header to the picked outlet (late old reply ignored)', async () => {
    storeUser({ businessName: 'Kumar General Store', outletName: 'Kumar GS' });
    const { container } = renderShell();
    await waitFor(() => expect(title(container)).toBe('Kumar GS'));
    // The pick happens BEFORE the initial /partner/me (own outlet) returns.
    act(() => { announceActivePartnerChanged(); });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1].resolve(okMe({ businessName: 'Kumar Wholesale', outletName: 'Kumar WS', activePartnerId: 'p-sib' }));
    });
    await waitFor(() => expect(title(container)).toBe('Kumar WS'));
    // The stale own-outlet reply lands late — it must NOT overwrite the picked outlet.
    await act(async () => {
      pending[0].resolve(okMe({ businessName: 'Kumar General Store', outletName: 'Kumar GS' }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(title(container)).toBe('Kumar WS');
  });
});
