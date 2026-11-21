/**
 * KYC-LG — the KYC wizard behind the location gate (features.requireLocation; docs/plans/LOCATION-GATE.md).
 *
 * KLG1: ON + permission denied → the wizard is replaced by the location guide (with a way back to the KYC list).
 * KLG2: ON + a fix → the wizard (outlet step) shows.
 * KLG3: explicit false (emergency off) → the wizard shows straight away and no location check runs.
 * KLG4: DEFAULT ON (owner 2026-11-21) — no stored key → gated.  KLG5: settings failure → gate ON up front.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

// The raw stored value (undefined = key ABSENT) goes through the REAL normalizeFeatures → isLocationRequired.
let REQUIRE_LOCATION: boolean | undefined = false;
let FEATURES_ERROR = false;
vi.mock('@/lib/tenant-features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenant-features')>();
  return {
    ...actual,
    useTenantFeatures: () => ({
      features: actual.normalizeFeatures(
        FEATURES_ERROR ? undefined : REQUIRE_LOCATION === undefined ? { outletMasterGeo: false } : { outletMasterGeo: false, requireLocation: REQUIRE_LOCATION },
      ),
      loading: false,
      error: FEATURES_ERROR,
    }),
  };
});

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
    // The wizard is mounted behind the guide but hidden (state kept).
    expect(screen.getByTestId('kyc-flow').hidden).toBe(true);
    expect(screen.getByLabelText('Back to KYC list').getAttribute('href')).toBe('/sales/kyc');

    getCurrentPosition.mockImplementation(fix);
    fireEvent.click(screen.getByTestId('location-gate-test-again'));
    await waitFor(() => expect(screen.getByTestId('kyc-flow').hidden).toBe(false));
  });

  it('REVIEW CRITICAL: a later block keeps the wizard MOUNTED (hidden) — the same DOM, so its state and the signature canvas survive', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(fix);
    let onPermChange: (() => void) | null = null;
    const status = { state: 'granted' as PermissionState, addEventListener: (_e: string, cb: () => void) => { onPermChange = cb; }, removeEventListener: vi.fn() };
    Object.defineProperty(navigator, 'permissions', { value: { query: vi.fn().mockResolvedValue(status) }, configurable: true });
    try {
      render(<NewKYCPage />);
      const root = await screen.findByTestId('kyc-new-root');
      await waitFor(() => expect(screen.getByTestId('kyc-flow').hidden).toBe(false));
      await waitFor(() => expect(onPermChange).not.toBeNull());
      // The rep blocks location mid-wizard (same path as a failed submit-time re-check).
      status.state = 'denied';
      await act(async () => onPermChange!());
      expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
      expect(screen.getByTestId('kyc-flow').hidden).toBe(true);
      expect(root.isConnected).toBe(true); // NOT unmounted
      status.state = 'granted';
      fireEvent.click(screen.getByTestId('location-gate-test-again'));
      await waitFor(() => expect(screen.getByTestId('kyc-flow').hidden).toBe(false));
      expect(screen.getByTestId('kyc-new-root')).toBe(root); // the very same wizard instance
    } finally {
      Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
    }
  });

  it('KLG2: ON + a fix → the wizard shows', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(fix);
    render(<NewKYCPage />);
    await waitFor(() => expect(screen.getByTestId('kyc-flow').hidden).toBe(false));
    expect(screen.queryByTestId('location-gate-blocked')).toBeNull();
  });

  it('KLG4: DEFAULT ON — key ABSENT + denied → the location guide (gate on without any stored value)', async () => {
    REQUIRE_LOCATION = undefined;
    getCurrentPosition.mockImplementation(denied);
    render(<NewKYCPage />);
    expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
    expect(screen.getByTestId('kyc-flow').hidden).toBe(true);
  });

  it('KLG5: settings load FAILED → treated as ON: the guide shows UP FRONT (never a full wizard the server then refuses) + the note', async () => {
    FEATURES_ERROR = true;
    getCurrentPosition.mockImplementation(denied);
    try {
      render(<NewKYCPage />);
      expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
      expect(screen.getByTestId('kyc-flow').hidden).toBe(true);
      expect(getCurrentPosition).toHaveBeenCalled();
      expect(screen.getByText(/Couldn't load programme settings — location may be required/)).toBeTruthy();
    } finally {
      FEATURES_ERROR = false;
    }
  });

  it('KLG3: explicit false (emergency off) → wizard straight away, no location check (unchanged)', async () => {
    REQUIRE_LOCATION = false;
    render(<NewKYCPage />);
    expect(screen.getByTestId('kyc-new-root')).toBeTruthy();
    expect(screen.queryByTestId('kyc-flow')).toBeNull(); // no wrapper at all for switch-off tenants
    await waitFor(() => expect(screen.queryByTestId('location-gate-checking')).toBeNull());
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
});
