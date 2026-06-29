import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstallBeacon from '../InstallBeacon';

// Drive matchMedia(display-mode: standalone) deterministically.
function stubStandalone(standalone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)' ? standalone : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // jsdom puts matchMedia on window — keep them in sync.
  (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
    window.matchMedia;
}

function stubUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile';

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('InstallBeacon', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.unstubAllEnvs();
    stubUserAgent(ANDROID_UA);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('(a) flag ON + standalone display-mode => POSTs once with the right platform', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    stubStandalone(true);
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/push/installed');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.platform).toBe('ANDROID');
    expect(body.userAgent).toBe(ANDROID_UA);
    // once-per-session guard set
    expect(sessionStorage.getItem('pwa-install-beacon-sent')).toBe('1');
  });

  it('(b) does NOT post when the flag is OFF (default)', async () => {
    stubStandalone(true);
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(c) does NOT post twice (sessionStorage guard already set)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    sessionStorage.setItem('pwa-install-beacon-sent', '1');
    stubStandalone(true);
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(c2) two mounts in one session only post once', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    stubStandalone(true);
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });
    await act(async () => {
      render(<InstallBeacon />);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(d) does NOT post when not standalone', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    stubStandalone(false);
    // ensure the legacy iOS flag is not accidentally truthy
    Object.defineProperty(navigator, 'standalone', { value: false, configurable: true });
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e) fires the beacon on the appinstalled event even when not standalone', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    stubStandalone(false);
    Object.defineProperty(navigator, 'standalone', { value: false, configurable: true });
    const fetchMock = mockFetch();

    await act(async () => {
      render(<InstallBeacon />);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).platform).toBe('ANDROID');
  });

  it('renders null (side-effect only)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PWA_INSTALL_ENABLED', 'true');
    stubStandalone(false);
    mockFetch();
    let container: HTMLElement | undefined;
    await act(async () => {
      ({ container } = render(<InstallBeacon />));
    });
    expect(container!.firstChild).toBeNull();
  });
});
