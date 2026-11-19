/**
 * KYC-LG — the KYC wizard behind the location gate (features.requireLocation; docs/plans/LOCATION-GATE.md).
 *
 * KLG1: ON + permission denied → the wizard is replaced by the location guide (with a way back to the KYC list).
 * KLG2: ON + a fix → the wizard (outlet step) shows.
 * KLG3: OFF (Deoleo) → the wizard shows straight away and no location check runs.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

let REQUIRE_LOCATION = false;
vi.mock('@/lib/tenant-features', () => ({
  useTenantFeatures: () => ({ features: { outletMasterGeo: false, requireLocation: REQUIRE_LOCATION }, loading: false }),
}));

import NewKYCPage from '../page';

const realGeo = navigator.geolocation;
const getCurrentPosition = vi.fn();
const fix = (cb: PositionCallback) => cb({ coords: { latitude: 12.9, longitude: 77.5, accuracy: 9 } } as GeolocationPosition);
const denied = (_c: PositionCallback, e: PositionErrorCallback) => e({ code: 1 } as GeolocationPositionError);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition, watchPosition: vi.fn().mockReturnValue(1), clearWatch: vi.fn() },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

describe('KYC-LG — KYC wizard location gate', () => {
  it('KLG1: ON + denied → location guide instead of the wizard, with a back link', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(denied);
    render(<NewKYCPage />);
    expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
    expect(screen.getByText(/Location is required to start or submit a KYC/)).toBeTruthy();
    expect(screen.queryByTestId('kyc-new-root')).toBeNull();
    expect(screen.getByLabelText('Back to KYC list').getAttribute('href')).toBe('/sales/kyc');

    getCurrentPosition.mockImplementation(fix);
    fireEvent.click(screen.getByTestId('location-gate-test-again'));
    expect(await screen.findByTestId('kyc-new-root')).toBeTruthy();
  });

  it('KLG2: ON + a fix → the wizard shows', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(fix);
    render(<NewKYCPage />);
    expect(await screen.findByTestId('kyc-new-root')).toBeTruthy();
    expect(screen.queryByTestId('location-gate-blocked')).toBeNull();
  });

  it('KLG3: OFF (Deoleo) → wizard straight away, no location check', async () => {
    REQUIRE_LOCATION = false;
    render(<NewKYCPage />);
    expect(screen.getByTestId('kyc-new-root')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('location-gate-checking')).toBeNull());
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
});
