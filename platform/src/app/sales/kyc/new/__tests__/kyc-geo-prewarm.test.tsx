/**
 * KYC geo pre-warm wiring (board photo, geo-fence tenants only).
 *
 * KGP1: a geo-fence tenant does NOT start the GPS watch at the OUTLET step — pre-warm is
 *       gated to the ADDRESS step (where the board photo is captured), so nothing fires early.
 * KGP2: a non-gated tenant (Deoleo) never starts a watch at all (byte-identical).
 *
 * (The pre-warm mechanism itself — starting the watch on mount for a geo-fence tenant and NOT
 * for a non-gated one — is proven directly in src/lib/__tests__/use-precise-gps.test.tsx.)
 */

import React from 'react';
import { render } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

let OUTLET_MASTER_GEO = false;
vi.mock('@/lib/tenant-features', () => ({
  useTenantFeatures: () => ({ features: { outletMasterGeo: OUTLET_MASTER_GEO }, loading: false }),
}));

import NewKYCPage from '../page';

const realGeo = navigator.geolocation;
const watchPosition = vi.fn().mockReturnValue(1);
const clearWatch = vi.fn();
const getCurrentPosition = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

describe('KYC board-photo GPS pre-warm', () => {
  it('KGP1: geo-fence tenant does NOT pre-warm at the outlet step (gated to the address step)', () => {
    OUTLET_MASTER_GEO = true;
    render(<NewKYCPage />);
    // The page opens on the OUTLET step; the board-photo pre-warm only arms on the ADDRESS step.
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('KGP2: non-gated tenant never starts a watch (Deoleo byte-identical)', () => {
    OUTLET_MASTER_GEO = false;
    render(<NewKYCPage />);
    expect(watchPosition).not.toHaveBeenCalled();
  });
});
