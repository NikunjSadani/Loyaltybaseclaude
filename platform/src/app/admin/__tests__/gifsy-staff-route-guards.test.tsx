import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression guard (RBAC Option-X): the GIFSY-OPERATOR admin subtrees that the sidebar shows
 * to a GIFSY_STAFF (gifsyOnly = canManageSchemes, true for staff) MUST also admit GIFSY_STAFF
 * at the route level. When these layouts were locked to ['GIFSY_ADMIN'] only, an assumed staff
 * (e.g. a "Project Manager") who clicked Scheme Management was rejected by RequireAuth →
 * getRoleHome('GIFSY_STAFF') = /gifsy → bounced back into /admin → infinite redirect LOOP.
 * The fine-grained capability is still enforced by the backend @RequirePermission on each
 * endpoint; this only fixes the coarse route gate so it matches the nav.
 */

// Capture the allowedRoles each layout hands to RequireAuth.
const captured: Record<string, string[] | undefined> = {};
let currentKey = '';
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ allowedRoles, children }: { allowedRoles?: string[]; children: React.ReactNode }) => {
    captured[currentKey] = allowedRoles;
    return <>{children}</>;
  },
}));

import SchemesLayout from '../schemes/layout';
import OutletWalletLayout from '../outlet-wallet/layout';
import VisibilityLayout from '../visibility/layout';
import PayoutsLayout from '../payouts/layout';

const LAYOUTS: Array<[string, React.ComponentType<{ children: React.ReactNode }>]> = [
  ['schemes', SchemesLayout],
  ['outlet-wallet', OutletWalletLayout],
  ['visibility', VisibilityLayout],
  ['payouts', PayoutsLayout],
];

describe('GIFSY_STAFF admin route guards (loop regression)', () => {
  beforeEach(() => {
    for (const k of Object.keys(captured)) delete captured[k];
  });

  it.each(LAYOUTS)('%s layout admits both GIFSY_ADMIN and GIFSY_STAFF', (key, Layout) => {
    currentKey = key;
    render(<Layout><div>child</div></Layout>);
    expect(captured[key]).toBeDefined();
    expect(captured[key]).toContain('GIFSY_ADMIN');
    // The load-bearing assertion: staff must not be excluded, or the nav-shown link loops.
    expect(captured[key]).toContain('GIFSY_STAFF');
  });
});
