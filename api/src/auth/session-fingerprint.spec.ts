import { deviceClass, isKnownFingerprint, sessionFingerprint } from './session-fingerprint';

const CHROME_ANDROID_130 = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const CHROME_ANDROID_131 = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36';
// Android Chrome with "Request desktop site" ON: reports X11 Linux and drops "Mobile".
const CHROME_ANDROID_DESKTOP_SITE = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI_IOS_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const SAFARI_IOS_18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
// iPhone / iPad Safari with "Request Desktop Website": reports Macintosh.
const SAFARI_IOS_DESKTOP_SITE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';

describe('sessionFingerprint (v3: stable, version-free, browser-only)', () => {
  it('a browser / OS UPDATE does not change it', () => {
    expect(sessionFingerprint({ userAgent: CHROME_ANDROID_130 })).toBe(sessionFingerprint({ userAgent: CHROME_ANDROID_131 }));
    expect(sessionFingerprint({ userAgent: SAFARI_IOS_17 })).toBe(sessionFingerprint({ userAgent: SAFARI_IOS_18 }));
  });

  it('L5: the "Request desktop site" toggle does not change it (android↔linux, ios↔macos, mobile flag ignored)', () => {
    expect(sessionFingerprint({ userAgent: CHROME_ANDROID_DESKTOP_SITE, mobile: '?0' })).toBe(
      sessionFingerprint({ userAgent: CHROME_ANDROID_131, mobile: '?1' }),
    );
    expect(sessionFingerprint({ userAgent: SAFARI_IOS_DESKTOP_SITE })).toBe(sessionFingerprint({ userAgent: SAFARI_IOS_18 }));
  });

  it('a different browser family or OS group DOES change it', () => {
    const fps = [CHROME_ANDROID_131, SAFARI_IOS_18, CHROME_IOS, CHROME_WIN, EDGE_WIN, SAMSUNG].map((ua) => sessionFingerprint({ userAgent: ua }));
    expect(new Set(fps).size).toBe(fps.length);
  });

  it('classifies families correctly (Edge / Samsung are not "chrome"; CriOS is chrome on ios)', () => {
    expect(deviceClass(EDGE_WIN)).toMatchObject({ browser: 'edge', osGroup: 'windows' });
    expect(deviceClass(SAMSUNG)).toMatchObject({ browser: 'samsung', osGroup: 'android-linux' });
    expect(deviceClass(CHROME_IOS)).toMatchObject({ browser: 'chrome', osGroup: 'apple' });
  });

  it('M1: a NON-browser User-Agent (Node / undici / curl) or none at all → UNKNOWN (null)', () => {
    for (const ua of ['node', 'undici', 'curl/8.4.0', 'Go-http-client/1.1', '', 'Mozilla/4.0 (compatible)']) {
      expect(sessionFingerprint({ userAgent: ua })).toBeNull();
    }
    expect(sessionFingerprint({})).toBeNull();
  });

  it('values carry the v3 prefix; anything else (e.g. stored before v3) is NOT a known fingerprint', () => {
    const fp = sessionFingerprint({ userAgent: CHROME_WIN })!;
    expect(fp.startsWith('v3:')).toBe(true);
    expect(isKnownFingerprint(fp)).toBe(true);
    expect(isKnownFingerprint('3f2a…legacy-v2-hash')).toBe(false);
    expect(isKnownFingerprint(null)).toBe(false);
  });
});
