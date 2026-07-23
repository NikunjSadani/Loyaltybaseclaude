/// <reference types="vitest/globals" />
/**
 * OS — Wave 3 outlet switcher (partner shell header)
 *
 * OS1: marks the currently-active outlet (matching active_partner_id) as current.
 * OS2: when nothing is selected (activePartnerId null), the OWN outlet is current.
 * OS3: choosing a different outlet writes the cookie via setActivePartner(partnerId).
 *
 * The switcher is exported from the partner layout so it can be tested in isolation
 * without mounting the whole shell (Sidebar / NavBottom / RequireAuth).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const setActivePartnerMock = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: (id: string | null) => setActivePartnerMock(id),
}));

// The layout imports these; stub them so importing the module is side-effect-free.
vi.mock('@/components/layout/nav-bottom', () => ({ NavBottom: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));
vi.mock('@/components/auth/require-auth', () => ({ RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => ({}) }));
vi.mock('@/lib/platform/client-config-context', () => ({ useClientConfig: () => ({ branding: {} }) }));
vi.mock('@/lib/auth-client', () => ({ logout: vi.fn(), PORTAL_ROLES: { partner: [] } }));

import { OutletSwitcher } from '../layout';

const OWN = {
  partnerId: 'p-own', outletId: 'o-own', outletCode: 'OUT-001',
  businessName: 'Kumar General Store', ownerName: 'Rajesh', isOwnLogin: true,
};
const SIB = {
  partnerId: 'p-sib', outletId: 'o-sib', outletCode: 'OUT-002',
  businessName: 'Kumar Wholesale', ownerName: 'Rajesh', isOwnLogin: false,
};

// window.location.href assignment isn't implemented in jsdom — stub it.
let originalLocation: Location;
beforeEach(() => {
  setActivePartnerMock.mockClear();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' } as Location,
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
});

describe('OS — outlet switcher', () => {
  it('OS1: marks the outlet matching active_partner_id as current', async () => {
    render(<OutletSwitcher outlets={[OWN, SIB]} activePartnerId="p-sib" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /kumar wholesale|switch outlet/i }));
    // The menu item for the sibling (active) carries aria-current=true; the own one does not.
    const items = screen.getAllByRole('menuitem');
    const sib = items.find((el) => el.textContent?.includes('Kumar Wholesale'));
    const own = items.find((el) => el.textContent?.includes('Kumar General Store'));
    expect(sib).toHaveAttribute('aria-current', 'true');
    expect(own).not.toHaveAttribute('aria-current');
  });

  it('OS2: with no selection, the own outlet is current', async () => {
    render(<OutletSwitcher outlets={[OWN, SIB]} activePartnerId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem');
    const own = items.find((el) => el.textContent?.includes('Kumar General Store'));
    expect(own).toHaveAttribute('aria-current', 'true');
  });

  it('OS3: choosing a different outlet sets the active-partner cookie', async () => {
    render(<OutletSwitcher outlets={[OWN, SIB]} activePartnerId={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: /kumar wholesale/i }));
    await waitFor(() => expect(setActivePartnerMock).toHaveBeenCalledWith('p-sib'));
  });

  it('OS4: clicking the already-active outlet does NOT re-set the cookie', async () => {
    render(<OutletSwitcher outlets={[OWN, SIB]} activePartnerId="p-sib" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /kumar wholesale|switch outlet/i }));
    await user.click(screen.getByRole('menuitem', { name: /kumar wholesale/i }));
    expect(setActivePartnerMock).not.toHaveBeenCalled();
  });
});
