/**
 * Location gate (docs/plans/LOCATION-GATE.md) — the pure check, the platform guide, the hook and the panel.
 *
 * LG1-LG6  checkLocation: permission denied (no request made) · granted + real fix → ok · POSITION_UNAVAILABLE ·
 *          TIMEOUT · no geolocation · Permissions API missing (Safari) → relies on the request result.
 * LG7      detectLocationPlatform + a guide per platform/reason (Android site settings + Google Location Accuracy;
 *          iPhone Safari Websites "While Using"; installed iPhone app; desktop).
 * LG8-LG11 useLocationGate + LocationGatePanel: OFF (Deoleo) never touches geolocation; ON shows "checking" then the
 *          flow on a fix; a block shows the guide and "Test again" recovers; quiet submit re-check.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLocation, detectLocationPlatform, locationGuide } from '../location-gate';
import { useLocationGate } from '../use-location-gate';
import { LocationGatePanel } from '@/components/location/LocationGatePanel';

const realGeo = navigator.geolocation;
const realPerms = (navigator as Navigator & { permissions?: Permissions }).permissions;

let getCurrentPosition: ReturnType<typeof vi.fn>;
let permissionState: PermissionState | null;

function installGeo() {
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(navigator, 'permissions', {
    value:
      permissionState === null
        ? undefined
        : { query: vi.fn().mockResolvedValue({ state: permissionState, addEventListener: vi.fn(), removeEventListener: vi.fn() }) },
    configurable: true,
  });
}

const fixOk = (cb: PositionCallback) =>
  cb({ coords: { latitude: 12.9, longitude: 77.5, accuracy: 14.4 } } as GeolocationPosition);
const fail = (code: number) => (_ok: PositionCallback, err: PositionErrorCallback) =>
  err({ code } as GeolocationPositionError);

beforeEach(() => {
  getCurrentPosition = vi.fn();
  permissionState = 'prompt';
  installGeo();
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
  Object.defineProperty(navigator, 'permissions', { value: realPerms, configurable: true });
});

describe('checkLocation', () => {
  it('LG1: permission DENIED → blocked "denied" without even asking for a position', async () => {
    permissionState = 'denied';
    installGeo();
    expect(await checkLocation()).toEqual({ ok: false, reason: 'denied' });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('LG2: granted + a real fix → ok with the rounded accuracy (high accuracy requested)', async () => {
    permissionState = 'granted';
    installGeo();
    getCurrentPosition.mockImplementation(fixOk);
    expect(await checkLocation()).toEqual({ ok: true, fix: { lat: 12.9, lng: 77.5, accuracy: 14 } });
    expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true });
  });

  it('LG3: allowed but no fix (phone Location off) → "unavailable"', async () => {
    getCurrentPosition.mockImplementation(fail(2));
    expect(await checkLocation()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('LG4: TIMEOUT → "timeout"; the user refusing at the prompt → "denied"', async () => {
    getCurrentPosition.mockImplementation(fail(3));
    expect(await checkLocation()).toEqual({ ok: false, reason: 'timeout' });
    getCurrentPosition.mockImplementation(fail(1));
    expect(await checkLocation()).toEqual({ ok: false, reason: 'denied' });
  });

  it('LG5: no geolocation in the browser → "unsupported"', async () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    expect(await checkLocation()).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('LG6: no Permissions API (older Safari) → relies on the request result', async () => {
    permissionState = null;
    installGeo();
    getCurrentPosition.mockImplementation(fixOk);
    expect((await checkLocation()).ok).toBe(true);
  });

  it('REVIEW: code 1 while the SITE permission reads granted → "device" (phone/app-level block)', async () => {
    permissionState = 'granted';
    installGeo();
    getCurrentPosition.mockImplementation(fail(1));
    expect(await checkLocation()).toEqual({ ok: false, reason: 'device' });
  });

  it('REVIEW: the 0,0 default is not a fix', async () => {
    getCurrentPosition.mockImplementation((cb: PositionCallback) =>
      cb({ coords: { latitude: 0, longitude: 0, accuracy: 5 } } as GeolocationPosition),
    );
    expect(await checkLocation()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('REVIEW: the never-called-back guard waits longer while a permission prompt may be open (45 s), short when granted', async () => {
    vi.useFakeTimers();
    try {
      getCurrentPosition.mockImplementation(() => undefined); // never calls back
      const p = checkLocation();
      await vi.advanceTimersByTimeAsync(44_000);
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await p).toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a garbage fix (NaN) is not a fix', async () => {
    getCurrentPosition.mockImplementation((cb: PositionCallback) =>
      cb({ coords: { latitude: NaN, longitude: 77.5, accuracy: 5 } } as GeolocationPosition),
    );
    expect(await checkLocation()).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('platform guide', () => {
  it('LG7: detects the platform and gives the matching, honest steps', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1';
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
    expect(detectLocationPlatform(android, false)).toBe('android');
    expect(detectLocationPlatform(iphone, false)).toBe('ios-safari');
    expect(detectLocationPlatform(iphone, true)).toBe('ios-app');
    expect(detectLocationPlatform(win, false)).toBe('desktop');

    expect(locationGuide('android', 'denied').steps.join(' ')).toMatch(/Site settings → Location/);
    expect(locationGuide('android', 'unavailable').steps.join(' ')).toMatch(/Google Location Accuracy/);
    expect(locationGuide('ios-safari', 'denied').steps.join(' ')).toMatch(/Safari Websites → choose “While Using the App”/);
    expect(locationGuide('ios-app', 'denied').steps.join(' ')).toMatch(/home screen/);
    expect(locationGuide('desktop', 'denied').steps.join(' ')).toMatch(/address bar/);
    // REVIEW: an app-level block on Android points at the phone's Chrome app permission.
    expect(locationGuide('android', 'device').steps.join(' ')).toMatch(/Settings → Apps → Chrome → Permissions → Location → Allow/);
    expect(locationGuide('android', 'device').steps.join(' ')).toMatch(/turn on Location/);
    // Honest: the page cannot see the phone's Location switch.
    expect(locationGuide('android', 'timeout').footnote).toMatch(/can't tell us whether the phone's Location switch is on/);
  });
});

// ─── Hook + panel ──────────────────────────────────────────────────────────────

function Harness({ enabled, onSubmit }: { enabled: boolean; onSubmit?: (ok: boolean) => void }) {
  const gate = useLocationGate(enabled);
  if (gate.blocking) return <LocationGatePanel gate={gate} purpose="start or submit a KYC" />;
  return (
    <div>
      <p>THE FLOW</p>
      <button onClick={async () => onSubmit?.(Boolean(await gate.recheck({ quiet: true })))}>submit</button>
    </div>
  );
}

describe('useLocationGate + LocationGatePanel', () => {
  it('LG8: OFF (Deoleo) → the flow renders and geolocation / permissions are never touched', () => {
    render(<Harness enabled={false} />);
    expect(screen.getByText('THE FLOW')).toBeTruthy();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect((navigator.permissions as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('LG9: ON → "Checking your location…" first, then the flow once a fix arrives', async () => {
    let deliver: PositionCallback | null = null;
    getCurrentPosition.mockImplementation((cb: PositionCallback) => {
      deliver = cb;
    });
    render(<Harness enabled />);
    expect(await screen.findByTestId('location-gate-checking')).toBeTruthy();
    expect(screen.queryByText('THE FLOW')).toBeNull();
    await waitFor(() => expect(deliver).not.toBeNull());
    await act(async () => fixOk(deliver!));
    expect(await screen.findByText('THE FLOW')).toBeTruthy();
  });

  it('LG10: ON + no fix → the guide (heading focused, steps, footnote); "Test again" recovers', async () => {
    getCurrentPosition.mockImplementation(fail(2));
    render(<Harness enabled />);
    const panel = await screen.findByTestId('location-gate-blocked');
    expect(panel.getAttribute('data-reason')).toBe('unavailable');
    const heading = screen.getByRole('heading', { name: /Couldn't get your location/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText(/Location is required to start or submit a KYC/)).toBeTruthy();

    getCurrentPosition.mockImplementation(fixOk);
    fireEvent.click(screen.getByTestId('location-gate-test-again'));
    expect(await screen.findByText('THE FLOW')).toBeTruthy();
  });

  it('REVIEW: "Test again" keeps the guide on screen (button "Checking…", focus kept) and announces a repeat failure', async () => {
    getCurrentPosition.mockImplementation(fail(2));
    render(<Harness enabled />);
    await screen.findByTestId('location-gate-blocked');
    let deliverErr: PositionErrorCallback | null = null;
    getCurrentPosition.mockImplementation((_ok: PositionCallback, err: PositionErrorCallback) => { deliverErr = err; });
    const btn = screen.getByTestId('location-gate-test-again');
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toMatch(/Checking…/));
    expect(screen.getByTestId('location-gate-blocked')).toBeTruthy(); // guide stays
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(btn);
    expect(screen.getByTestId('location-gate-live').textContent).toMatch(/Checking your location/);
    await waitFor(() => expect(deliverErr).not.toBeNull());
    await act(async () => deliverErr!({ code: 2 } as GeolocationPositionError));
    await waitFor(() => expect(btn.textContent).toMatch(/Test again/));
    expect(screen.getByTestId('location-gate-still-blocked')).toBeTruthy();
    expect(screen.getByTestId('location-gate-live').textContent).toMatch(/Still no location/);
  });

  it('LG11: submit-time quiet re-check — OK keeps the flow; a lost fix switches to the guide and reports false', async () => {
    getCurrentPosition.mockImplementation(fixOk);
    const results: boolean[] = [];
    render(<Harness enabled onSubmit={(ok) => results.push(ok)} />);
    await screen.findByText('THE FLOW');
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(results).toEqual([true]));
    expect(screen.getByText('THE FLOW')).toBeTruthy();

    getCurrentPosition.mockImplementation(fail(3));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(results).toEqual([true, false]));
    expect((await screen.findByTestId('location-gate-blocked')).getAttribute('data-reason')).toBe('timeout');
  });
});
